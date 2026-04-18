"""Deal Scout CRM backend. FastAPI + Firestore + Gemini vision OM ingestion."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import secrets
import urllib.request
import urllib.error
import uuid
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.cloud import firestore as gcfs

from .auth import require_user
from .config import settings
from .firebase_admin_client import get_bucket, get_db
from .om_extractor import extract_from_documents
from .underwriting import (
    build_proforma_from_ttm,
    compute_noi,
    compute_returns,
    default_assumptions,
)

log = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

app = FastAPI(title="Deal Scout CRM API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins if settings.allowed_origins else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _frame_headers(request, call_next):
    response = await call_next(request)
    response.headers.setdefault(
        "Content-Security-Policy",
        "frame-ancestors 'self' https://*.anthropic.com https://*.claude.ai https://*.run.app",
    )
    response.headers.setdefault("X-Frame-Options", "ALLOWALL")
    return response


@app.get("/")
def root() -> dict[str, Any]:
    return {"service": "deal-scout-api", "status": "ok"}


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {"status": "ok", "model": settings.gemini_model}


# ---------- Helpers ----------


def _num_or_none(v: Any) -> float | int | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        if isinstance(v, float) and not math.isfinite(v):
            return None
        return v
    if isinstance(v, str):
        s = v.strip().replace(",", "")
        if not s:
            return None
        try:
            f = float(s)
        except ValueError:
            return None
        if not math.isfinite(f):
            return None
        return int(f) if f.is_integer() else f
    return None


def _clean_doc(d: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in d.items():
        if v is None:
            continue
        if isinstance(v, float) and not math.isfinite(v):
            continue
        out[k] = v
    return out


def _clean_line_items(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    for li in items:
        if not isinstance(li, dict):
            continue
        label = li.get("label")
        label = str(label).strip() if label is not None else ""
        amt = _num_or_none(li.get("amount"))
        if amt is None:
            amt = 0
        out.append({"label": label or "unlabeled", "amount": amt})
    return out


def _clean_statement(stmt: Any) -> dict[str, Any]:
    if not isinstance(stmt, dict):
        return {"revenue": [], "expenses": []}
    return {
        "revenue": _clean_line_items(stmt.get("revenue")),
        "expenses": _clean_line_items(stmt.get("expenses")),
    }


def _clean_monthly_lines(items: Any) -> list[dict[str, Any]]:
    """Normalize [{label, amounts:[...]}] lists to exactly 12 float amounts."""
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    for li in items:
        if not isinstance(li, dict):
            continue
        label = li.get("label")
        label = str(label).strip() if label is not None else ""
        raw_amts = li.get("amounts")
        if not isinstance(raw_amts, list):
            continue
        amts: list[float] = []
        for a in raw_amts:
            n = _num_or_none(a)
            amts.append(float(n) if n is not None else 0.0)
        # Pad or truncate to 12 months for consistency.
        if len(amts) < 12:
            amts = amts + [0.0] * (12 - len(amts))
        elif len(amts) > 12:
            amts = amts[:12]
        out.append({"label": label or "unlabeled", "amounts": amts})
    return out


def _clean_monthly_statement(stmt: Any, source: str = "om") -> dict[str, Any] | None:
    """Return a normalized monthly statement or None if there's no usable data."""
    if not isinstance(stmt, dict):
        return None
    months_raw = stmt.get("months")
    revenue = _clean_monthly_lines(stmt.get("revenue"))
    expenses = _clean_monthly_lines(stmt.get("expenses"))
    if not revenue and not expenses:
        return None
    months: list[str] = []
    if isinstance(months_raw, list):
        for m in months_raw:
            months.append(str(m) if m is not None else "")
    # Pad months to 12 slots to align with amounts arrays.
    if len(months) < 12:
        months = months + [""] * (12 - len(months))
    elif len(months) > 12:
        months = months[:12]
    return {
        "months": months,
        "revenue": revenue,
        "expenses": expenses,
        "source": source,
    }


def _monthly_to_annual_totals(monthly: dict[str, Any] | None) -> dict[str, Any] | None:
    """Convert a monthly statement back to annual {revenue, expenses} totals."""
    if not monthly:
        return None
    rev = [
        {"label": li["label"], "amount": round(sum(li.get("amounts") or []), 2)}
        for li in (monthly.get("revenue") or [])
    ]
    exp = [
        {"label": li["label"], "amount": round(sum(li.get("amounts") or []), 2)}
        for li in (monthly.get("expenses") or [])
    ]
    return {"revenue": rev, "expenses": exp}


def _derive_proforma_monthly(
    ttm_monthly: dict[str, Any] | None,
    a: dict[str, float],
) -> dict[str, Any] | None:
    """Given TTM monthly data, produce a 12-month proforma by escalating each
    line by its growth rate and advancing the month stamps by 12 months."""
    if not ttm_monthly:
        return None
    rent_growth = float(a.get("rent_growth_pct", 0.03))
    expense_growth = float(a.get("expense_growth_pct", 0.025))

    def _bump_month(ym: str) -> str:
        try:
            y, m = ym.split("-")
            return f"{int(y) + 1}-{m}"
        except Exception:
            return ym

    months = [_bump_month(m) for m in (ttm_monthly.get("months") or [])]
    revenue = [
        {
            "label": li["label"],
            "amounts": [round(x * (1 + rent_growth), 2) for x in (li.get("amounts") or [])],
        }
        for li in (ttm_monthly.get("revenue") or [])
    ]
    expenses = [
        {
            "label": li["label"],
            "amounts": [round(x * (1 + expense_growth), 2) for x in (li.get("amounts") or [])],
        }
        for li in (ttm_monthly.get("expenses") or [])
    ]
    return {
        "months": months,
        "revenue": revenue,
        "expenses": expenses,
        "source": "derived",
    }


def _deep_clean(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        out: dict[str, Any] = {}
        for k, x in v.items():
            cleaned = _deep_clean(x)
            if cleaned is None:
                continue
            out[k] = cleaned
        return out
    if isinstance(v, list):
        return [_deep_clean(x) for x in v if _deep_clean(x) is not None or isinstance(x, (dict, list))]
    return v


def _safe_returns(r) -> dict[str, float | None]:
    return {
        "irr": _num_or_none(r.irr),
        "equity_multiple": _num_or_none(r.equity_multiple),
        "coc_yr1": _num_or_none(r.coc_yr1),
        "dscr": _num_or_none(r.dscr),
    }


# ---------- Workspace / membership helpers ----------


def _effective_workspace(uid: str) -> str:
    """Return the workspace owner uid for this user. Defaults to their own uid."""
    try:
        snap = get_db().collection("users").document(uid).get()
        if not snap.exists:
            return uid
        data = snap.to_dict() or {}
        return (data.get("workspace_owner_uid") or uid).strip() or uid
    except Exception:
        log.exception("effective_workspace read failed uid=%s", uid)
        return uid


def _can_access(uid: str, owner_uid: str) -> bool:
    """True if uid can read docs owned by owner_uid. View is always granted
    to any listed member; per-action permissions are enforced separately."""
    if uid == owner_uid:
        return True
    try:
        snap = (
            get_db()
            .collection("workspace_members")
            .document(f"{owner_uid}_{uid}")
            .get()
        )
        return snap.exists
    except Exception:
        log.exception("can_access check failed owner=%s member=%s", owner_uid, uid)
        return False


# Default permission sets. Admin always has everything implicitly.
DEFAULT_PERMISSIONS = {
    "view": True,
    "create": True,
    "edit": True,
    "delete": False,
    "underwrite": True,
    "invite_others": False,
}

PERMISSION_PRESETS: dict[str, dict[str, bool]] = {
    "viewer":   {"view": True,  "create": False, "edit": False, "delete": False, "underwrite": False, "invite_others": False},
    "analyst":  {"view": True,  "create": False, "edit": False, "delete": False, "underwrite": True,  "invite_others": False},
    "editor":   {"view": True,  "create": True,  "edit": True,  "delete": False, "underwrite": True,  "invite_others": False},
    "manager":  {"view": True,  "create": True,  "edit": True,  "delete": True,  "underwrite": True,  "invite_others": False},
    "admin":    {"view": True,  "create": True,  "edit": True,  "delete": True,  "underwrite": True,  "invite_others": True},
}


def _normalize_permissions(raw: Any) -> dict[str, bool]:
    """Coerce an arbitrary permissions dict into a well-formed bool map."""
    out = dict(DEFAULT_PERMISSIONS)
    if isinstance(raw, dict):
        for k in list(out.keys()):
            if k in raw:
                out[k] = bool(raw[k])
    return out


def _permissions_for(uid: str, owner_uid: str) -> dict[str, bool]:
    """Return the effective permission map for uid acting on owner_uid's data.
    Owner always gets everything. Members read their membership doc. Unknown
    users get an all-false map."""
    if uid == owner_uid:
        return {k: True for k in DEFAULT_PERMISSIONS.keys()}
    try:
        snap = (
            get_db()
            .collection("workspace_members")
            .document(f"{owner_uid}_{uid}")
            .get()
        )
        if not snap.exists:
            return {k: False for k in DEFAULT_PERMISSIONS.keys()}
        data = snap.to_dict() or {}
        return _normalize_permissions(data.get("permissions"))
    except Exception:
        log.exception("permissions_for failed owner=%s member=%s", owner_uid, uid)
        return {k: False for k in DEFAULT_PERMISSIONS.keys()}


def _require_permission(uid: str, owner_uid: str, action: str) -> None:
    """Raise 403 unless uid has the named permission on owner_uid's workspace."""
    perms = _permissions_for(uid, owner_uid)
    if not perms.get(action):
        raise HTTPException(
            status_code=403,
            detail=f"Missing permission '{action}' for this workspace",
        )


# ---------- Settings ----------


def _user_gemini_key(uid: str) -> str | None:
    """Read the Gemini key for the effective workspace. Members share the owner's key."""
    try:
        ws = _effective_workspace(uid)
        snap = get_db().collection("users").document(ws).get()
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        key = data.get("gemini_api_key")
        return key.strip() if isinstance(key, str) and key.strip() else None
    except Exception:
        log.exception("user_gemini_key read failed for uid=%s", uid)
        return None


@app.get("/api/settings")
def get_settings(user: dict = Depends(require_user)) -> dict[str, Any]:
    uid = user["uid"]
    ws = _effective_workspace(uid)
    key = _user_gemini_key(uid)
    fallback = bool(settings.gemini_api_key)
    return {
        "has_user_key": bool(key),
        "has_fallback_key": fallback,
        "model": settings.gemini_model,
        "email": user.get("email"),
        "uid": uid,
        "workspace_owner_uid": ws,
        "is_workspace_owner": ws == uid,
    }


@app.post("/api/settings")
def save_settings(
    payload: dict[str, Any],
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    key = payload.get("gemini_api_key")
    if key is not None and not isinstance(key, str):
        raise HTTPException(status_code=400, detail="gemini_api_key must be a string")
    db = get_db()
    # The Gemini key always saves to the caller's own profile (their workspace when they're owner).
    ref = db.collection("users").document(user["uid"])
    ref.set(
        {
            "gemini_api_key": (key or "").strip() or None,
            "email": user.get("email"),
            "updated_at": gcfs.SERVER_TIMESTAMP,
        },
        merge=True,
    )
    return {"ok": True, "has_user_key": bool((key or "").strip())}


# ---------- Ingest ----------


@app.post("/api/ingest")
async def create_ingest(
    background: BackgroundTasks,
    files: list[UploadFile] = File(...),
    workspace_owner_uid: str | None = Form(default=None),
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    user_key = _user_gemini_key(user["uid"])
    if not user_key and not settings.gemini_api_key:
        raise HTTPException(
            status_code=400,
            detail="Add your Gemini API key on the Settings page before uploading an OM.",
        )

    db = get_db()
    bucket = get_bucket()
    ingestion_id = str(uuid.uuid4())
    storage_paths: list[str] = []
    doc_payload: list[tuple[str, bytes, str]] = []

    for f in files:
        raw = await f.read()
        mime = f.content_type or "application/octet-stream"
        safe_name = f.filename or f"doc-{uuid.uuid4().hex}"
        path = f"om_ingestions/{ingestion_id}/{safe_name}"
        blob = bucket.blob(path)
        blob.upload_from_string(raw, content_type=mime)
        storage_paths.append(path)
        doc_payload.append((safe_name, raw, mime))

    # Resolve target workspace. If the client passed workspace_owner_uid, verify
    # access; otherwise fall back to the user's default (their own) workspace.
    requested_ws = (workspace_owner_uid or "").strip() or None
    if requested_ws and not _can_access(user["uid"], requested_ws):
        raise HTTPException(status_code=403, detail="Not a member of that workspace")
    owner_uid = requested_ws or _effective_workspace(user["uid"])
    db.collection("om_ingestions").document(ingestion_id).set(
        {
            "owner_uid": owner_uid,
            "storage_path": storage_paths,
            "building_id": None,
            "extraction_status": "pending",
            "raw_extraction": None,
            "confirmed_at": None,
            "error": None,
            "created_at": gcfs.SERVER_TIMESTAMP,
            "created_by": user.get("email"),
            "created_by_uid": user["uid"],
        }
    )

    background.add_task(_run_extraction, ingestion_id, doc_payload, user_key)
    return {"ingestion_id": ingestion_id}


def _run_extraction(
    ingestion_id: str,
    docs: list[tuple[str, bytes, str]],
    api_key: str | None,
) -> None:
    db = get_db()
    ref = db.collection("om_ingestions").document(ingestion_id)
    ref.update({"extraction_status": "running"})
    try:
        extracted = extract_from_documents(docs, api_key=api_key)
        ref.update({"extraction_status": "done", "raw_extraction": extracted})
    except Exception as exc:
        log.exception("Extraction failed for %s", ingestion_id)
        ref.update({"extraction_status": "error", "error": str(exc)})


@app.get("/api/ingest/{ingestion_id}")
def get_ingest(ingestion_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    db = get_db()
    snap = db.collection("om_ingestions").document(ingestion_id).get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Ingestion not found")
    data = snap.to_dict() or {}
    owner = data.get("owner_uid")
    if owner and not _can_access(user["uid"], owner):
        raise HTTPException(status_code=404, detail="Ingestion not found")
    return {
        "id": ingestion_id,
        "extraction_status": data.get("extraction_status", "pending"),
        "raw_extraction": data.get("raw_extraction"),
        "error": data.get("error"),
    }


@app.post("/api/ingest/{ingestion_id}/confirm")
def confirm_ingest(
    ingestion_id: str,
    payload: dict[str, Any],
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    log.info("confirm_ingest start id=%s user=%s", ingestion_id, user.get("email"))
    try:
        db = get_db()
        ingest_ref = db.collection("om_ingestions").document(ingestion_id)
        ingest_snap = ingest_ref.get()
        if not ingest_snap.exists:
            raise HTTPException(status_code=404, detail="Ingestion not found")
        ingest_data = ingest_snap.to_dict() or {}
        owner = ingest_data.get("owner_uid") or _effective_workspace(user["uid"])
        if not _can_access(user["uid"], owner):
            raise HTTPException(status_code=404, detail="Ingestion not found")

        building_in = payload.get("building") or {}
        address = (building_in.get("address") or "").strip()
        if not address:
            raise HTTPException(status_code=400, detail="Building address is required")

        asset_class = building_in.get("asset_class") or "multifamily"
        building_doc_raw = {
            "owner_uid": owner,
            "address": address,
            "city": building_in.get("city"),
            "state": building_in.get("state"),
            "zip": building_in.get("zip"),
            "asset_class": asset_class,
            "units": _num_or_none(building_in.get("units")),
            "sf": _num_or_none(building_in.get("sf")),
            "nrsf": _num_or_none(building_in.get("nrsf")),
            "keys": _num_or_none(building_in.get("keys")),
            "zoning": building_in.get("zoning"),
            "entitlements": building_in.get("entitlements"),
            "year_built": _num_or_none(building_in.get("year_built")),
            "year_renovated": _num_or_none(building_in.get("year_renovated")),
            "occupancy": _num_or_none(building_in.get("occupancy")),
            "current_noi": _num_or_none(building_in.get("current_noi")),
            "asking_price": _num_or_none(building_in.get("asking_price")),
            "cap_rate": _num_or_none(building_in.get("cap_rate")),
            "adr": _num_or_none(building_in.get("adr")),
            "revpar": _num_or_none(building_in.get("revpar")),
            "notes": building_in.get("notes"),
            "photos": [],
            "documents": [
                f"gs://{settings.firebase_storage_bucket}/{p}"
                for p in (ingest_snap.to_dict() or {}).get("storage_path", []) or []
            ],
            "created_at": gcfs.SERVER_TIMESTAMP,
            "updated_at": gcfs.SERVER_TIMESTAMP,
        }
        building_doc = _clean_doc(building_doc_raw)
        building_ref = db.collection("buildings").document()
        log.info("confirm_ingest writing building id=%s fields=%d", building_ref.id, len(building_doc))
        building_ref.set(building_doc)
        building_id = building_ref.id

        contact_ids: list[str] = []
        for c in payload.get("contacts") or []:
            name = (c.get("name") or "").strip()
            if not name:
                continue
            contact_ref = db.collection("contacts").document()
            contact_doc = _clean_doc({
                "owner_uid": owner,
                "name": name,
                "role": c.get("role") or "other",
                "firm": c.get("firm"),
                "email": c.get("email"),
                "phone": c.get("phone"),
                "linkedin": c.get("linkedin"),
                "notes": c.get("notes"),
                "related_buildings": [building_id],
                "related_deals": [],
                "created_at": gcfs.SERVER_TIMESTAMP,
                "updated_at": gcfs.SERVER_TIMESTAMP,
            })
            contact_ref.set(contact_doc)
            contact_ids.append(contact_ref.id)

        financials = payload.get("financials") or {}
        ttm_raw = financials.get("ttm") or {"revenue": [], "expenses": []}
        ttm = _clean_statement(ttm_raw)

        # Monthly breakdowns (when the OM provides them). We clean them first
        # so we can use the TTM monthly totals to back-fill the annual TTM if
        # the model only returned a monthly grid.
        ttm_monthly = _clean_monthly_statement(financials.get("ttm_monthly"), source="om")
        if ttm_monthly and not (ttm.get("revenue") or ttm.get("expenses")):
            backfilled = _monthly_to_annual_totals(ttm_monthly)
            if backfilled:
                ttm = _clean_statement(backfilled)

        try:
            ttm["noi"] = float(compute_noi(ttm))
            if not math.isfinite(ttm["noi"]):
                ttm["noi"] = 0.0
        except Exception:
            ttm["noi"] = 0.0

        ttm_period = financials.get("ttm_period") or {}
        if isinstance(ttm_period, dict):
            ttm_period = {
                "start_month": str(ttm_period.get("start_month") or "") or None,
                "end_month": str(ttm_period.get("end_month") or "") or None,
                "label": str(ttm_period.get("label") or "") or None,
            }
        else:
            ttm_period = {}

        assumptions = default_assumptions(asset_class)

        # Prefer the OM's own 12-month proforma when it provides one. Otherwise
        # derive it from TTM monthly (if we have it) or from annual TTM.
        proforma_monthly = _clean_monthly_statement(financials.get("proforma_12mo"), source="om")
        if not proforma_monthly and ttm_monthly:
            proforma_monthly = _derive_proforma_monthly(ttm_monthly, assumptions)

        uw_id: str | None = None
        try:
            if proforma_monthly:
                derived_annual = _monthly_to_annual_totals(proforma_monthly) or {"revenue": [], "expenses": []}
                proforma = _clean_statement(derived_annual)
            else:
                proforma_raw = build_proforma_from_ttm(ttm, assumptions)
                proforma = _clean_statement(proforma_raw)
            proforma["noi"] = float(compute_noi(proforma))
            if not math.isfinite(proforma["noi"]):
                proforma["noi"] = 0.0
            returns = compute_returns(building_doc, ttm, proforma, assumptions)
            uw_payload = _deep_clean({
                "owner_uid": owner,
                "building_id": building_id,
                "asset_class": asset_class,
                "ttm": ttm,
                "ttm_period": ttm_period,
                "ttm_monthly": ttm_monthly,
                "proforma_12mo": proforma,
                "proforma_12mo_monthly": proforma_monthly,
                "assumptions": assumptions,
                "returns": _safe_returns(returns),
                "version": 1,
                "created_at": gcfs.SERVER_TIMESTAMP,
            })
            uw_ref = db.collection("underwriting").document()
            uw_ref.set(uw_payload)
            uw_id = uw_ref.id
        except Exception:
            log.exception("confirm_ingest underwriting math/write failed")
            try:
                uw_ref = db.collection("underwriting").document()
                uw_ref.set(_deep_clean({
                    "owner_uid": owner,
                    "building_id": building_id,
                    "asset_class": asset_class,
                    "ttm": ttm,
                    "ttm_period": ttm_period,
                    "ttm_monthly": ttm_monthly,
                    "proforma_12mo": {"revenue": [], "expenses": [], "noi": 0.0},
                    "proforma_12mo_monthly": proforma_monthly,
                    "assumptions": assumptions,
                    "returns": {"irr": None, "equity_multiple": None, "coc_yr1": None, "dscr": None},
                    "version": 1,
                    "created_at": gcfs.SERVER_TIMESTAMP,
                    "note": "underwriting math failed at ingest; re-run from the building page",
                }))
                uw_id = uw_ref.id
            except Exception:
                log.exception("placeholder underwriting write also failed")
                uw_id = None

        ingest_ref.update(
            {
                "building_id": building_id,
                "confirmed_at": gcfs.SERVER_TIMESTAMP,
            }
        )

        return {"building_id": building_id, "contact_ids": contact_ids, "underwriting_id": uw_id}
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("confirm_ingest failed id=%s", ingestion_id)
        raise HTTPException(status_code=500, detail=f"confirm failed: {exc}") from exc


# ---------- Underwriting calc ----------


@app.post("/api/underwriting/{building_id}/calc")
def calc_underwriting(
    building_id: str,
    payload: dict[str, Any],
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    db = get_db()
    b_snap = db.collection("buildings").document(building_id).get()
    if not b_snap.exists:
        raise HTTPException(status_code=404, detail="Building not found")
    building = b_snap.to_dict() or {}
    owner = building.get("owner_uid")
    if owner and not _can_access(user["uid"], owner):
        raise HTTPException(status_code=404, detail="Building not found")
    ttm = payload.get("ttm") or {"revenue": [], "expenses": []}
    ttm["noi"] = compute_noi(ttm)
    assumptions = payload.get("assumptions") or default_assumptions(building.get("asset_class", "multifamily"))
    proforma = payload.get("proforma_12mo") or build_proforma_from_ttm(ttm, assumptions)
    proforma["noi"] = compute_noi(proforma)
    returns = compute_returns(building, ttm, proforma, assumptions)
    return {
        "ttm": ttm,
        "proforma_12mo": proforma,
        "assumptions": assumptions,
        "returns": _safe_returns(returns),
    }


# ---------- Members + invites ----------


def _send_invite_email(to_email: str, accept_url: str, inviter: str, workspace_name: str) -> bool:
    """Attempt to send an invite email. Returns True if sent. If no provider is
    configured, returns False and the UI will surface the link for manual copy."""
    api_key = os.getenv("RESEND_API_KEY")
    from_addr = os.getenv("INVITE_FROM_EMAIL", "Deal Scout <onboarding@resend.dev>")
    if not api_key:
        log.info("invite email skipped (no RESEND_API_KEY) -> %s", to_email)
        return False
    body = {
        "from": from_addr,
        "to": [to_email],
        "subject": f"You've been invited to Deal Scout ({workspace_name})",
        "html": f"""
            <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
              <h2 style="margin:0 0 12px 0">You're invited to {workspace_name}</h2>
              <p style="color:#444">{inviter} has invited you to collaborate on the Deal Scout CRM.</p>
              <p style="margin:24px 0">
                <a href="{accept_url}" style="background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;display:inline-block;font-weight:600">Accept invite</a>
              </p>
              <p style="color:#888;font-size:12px">Or paste this link in your browser: <br /><a href="{accept_url}">{accept_url}</a></p>
            </div>
        """,
    }
    try:
        req = urllib.request.Request(
            "https://api.resend.com/emails",
            data=json.dumps(body).encode(),
            method="POST",
        )
        req.add_header("Authorization", f"Bearer {api_key}")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
        return True
    except Exception:
        log.exception("Resend send failed for %s", to_email)
        return False


@app.get("/api/workspace/diagnose")
def diagnose_workspace(user: dict = Depends(require_user)) -> dict[str, Any]:
    """Return everything we know about this user's workspace wiring so
    sharing issues can be debugged. Returns: the caller's uid+email, their
    own data counts, every workspace_members row they appear in (as member
    OR owner), invites addressed to them, and for each membership a count
    of the shared workspace's buildings/contacts."""
    db = get_db()
    uid = user["uid"]
    email = (user.get("email") or "").lower()

    def count(coll: str, owner: str) -> int:
        try:
            return sum(
                1
                for _ in db.collection(coll)
                .where(filter=gcfs.FieldFilter("owner_uid", "==", owner))
                .stream()
            )
        except Exception:
            log.exception("diagnose count failed coll=%s owner=%s", coll, owner)
            return -1

    own_snap = db.collection("users").document(uid).get()
    own_profile = own_snap.to_dict() if own_snap.exists else {}

    memberships_as_member: list[dict[str, Any]] = []
    try:
        for m in (
            db.collection("workspace_members")
            .where(filter=gcfs.FieldFilter("member_uid", "==", uid))
            .stream()
        ):
            d = m.to_dict() or {}
            owner_uid = d.get("owner_uid")
            owner_email = None
            if owner_uid:
                os_ = db.collection("users").document(owner_uid).get()
                owner_email = (os_.to_dict() or {}).get("email") if os_.exists else None
            memberships_as_member.append({
                "doc_id": m.id,
                "owner_uid": owner_uid,
                "owner_email": owner_email,
                "role": d.get("role"),
                "buildings_in_workspace": count("buildings", owner_uid) if owner_uid else None,
                "contacts_in_workspace": count("contacts", owner_uid) if owner_uid else None,
            })
    except Exception:
        log.exception("diagnose memberships-as-member failed uid=%s", uid)

    memberships_as_owner: list[dict[str, Any]] = []
    try:
        for m in (
            db.collection("workspace_members")
            .where(filter=gcfs.FieldFilter("owner_uid", "==", uid))
            .stream()
        ):
            d = m.to_dict() or {}
            memberships_as_owner.append({
                "doc_id": m.id,
                "member_uid": d.get("member_uid"),
                "member_email": d.get("email"),
                "role": d.get("role"),
            })
    except Exception:
        log.exception("diagnose memberships-as-owner failed uid=%s", uid)

    invites_to_me: list[dict[str, Any]] = []
    if email:
        try:
            for iv in (
                db.collection("invites")
                .where(filter=gcfs.FieldFilter("email", "==", email))
                .stream()
            ):
                d = iv.to_dict() or {}
                invites_to_me.append({
                    "token": iv.id,
                    "owner_uid": d.get("owner_uid"),
                    "inviter_email": d.get("inviter_email"),
                    "accepted": bool(d.get("accepted")),
                    "created_at": d.get("created_at"),
                })
        except Exception:
            log.exception("diagnose invites lookup failed email=%s", email)

    return {
        "uid": uid,
        "email": email,
        "profile": {
            "email": (own_profile or {}).get("email"),
            "workspace_owner_uid": (own_profile or {}).get("workspace_owner_uid"),
        },
        "own_data": {
            "buildings": count("buildings", uid),
            "contacts": count("contacts", uid),
        },
        "memberships_as_member": memberships_as_member,
        "memberships_as_owner": memberships_as_owner,
        "invites_to_me": invites_to_me,
    }


@app.get("/api/workspace/list")
def list_my_workspaces(user: dict = Depends(require_user)) -> dict[str, Any]:
    """List every workspace the caller can access.

    Returns their own (as owner) plus every workspace they're a member of
    (via /workspace_members/{owner}_{me}). The client uses this to populate
    the workspace switcher on the dashboard.
    """
    db = get_db()
    uid = user["uid"]
    email = user.get("email") or ""
    out: list[dict[str, Any]] = []
    # Own workspace
    own_snap = db.collection("users").document(uid).get()
    own_data = own_snap.to_dict() if own_snap.exists else {}
    out.append({
        "owner_uid": uid,
        "owner_email": (own_data or {}).get("email") or email,
        "role": "owner",
        "label": "My deals",
        "permissions": {k: True for k in DEFAULT_PERMISSIONS.keys()},
    })
    # Memberships
    try:
        for m in (
            db.collection("workspace_members")
            .where(filter=gcfs.FieldFilter("member_uid", "==", uid))
            .stream()
        ):
            data = m.to_dict() or {}
            owner_uid = data.get("owner_uid")
            if not owner_uid or owner_uid == uid:
                continue
            # Resolve owner email for a nicer label
            owner_snap = db.collection("users").document(owner_uid).get()
            owner_email = (owner_snap.to_dict() or {}).get("email") if owner_snap.exists else None
            out.append({
                "owner_uid": owner_uid,
                "owner_email": owner_email or "",
                "role": data.get("role") or "editor",
                "label": f"Shared with you: {owner_email}" if owner_email else "Shared deals",
                "permissions": _normalize_permissions(data.get("permissions")),
            })
    except Exception:
        log.exception("list_my_workspaces memberships read failed uid=%s", uid)
    return {"workspaces": out, "default_owner_uid": _effective_workspace(uid)}


@app.get("/api/workspace/members")
def list_members(user: dict = Depends(require_user)) -> dict[str, Any]:
    """List members of the workspace the caller owns. Members are listed via
    /workspace_members where owner_uid == caller uid."""
    db = get_db()
    uid = user["uid"]
    rows: list[dict[str, Any]] = []
    # Owner (caller) is always a member implicitly.
    own_snap = db.collection("users").document(uid).get()
    own_email = (own_snap.to_dict() or {}).get("email") or user.get("email") or ""
    rows.append({
        "uid": uid,
        "email": own_email,
        "role": "owner",
        "invited_at": None,
    })
    for m in (
        db.collection("workspace_members")
        .where(filter=gcfs.FieldFilter("owner_uid", "==", uid))
        .stream()
    ):
        data = m.to_dict() or {}
        rows.append({
            "uid": data.get("member_uid"),
            "email": data.get("email") or "",
            "role": data.get("role") or "editor",
            "permissions": _normalize_permissions(data.get("permissions")),
            "invited_at": data.get("created_at"),
        })
    # Pending invites
    invites: list[dict[str, Any]] = []
    for iv in (
        db.collection("invites")
        .where(filter=gcfs.FieldFilter("owner_uid", "==", uid))
        .where(filter=gcfs.FieldFilter("accepted", "==", False))
        .stream()
    ):
        d = iv.to_dict() or {}
        invites.append({
            "token": iv.id,
            "email": d.get("email"),
            "permissions": _normalize_permissions(d.get("permissions")),
            "created_at": d.get("created_at"),
        })
    return {"members": rows, "invites": invites, "presets": PERMISSION_PRESETS}


@app.post("/api/workspace/invites")
def create_invite(
    payload: dict[str, Any],
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    email = (payload.get("email") or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Valid email required")
    origin = (payload.get("origin") or "").rstrip("/")
    if not origin:
        raise HTTPException(status_code=400, detail="origin required to build accept link")

    # Permissions: prefer explicit map; otherwise derive from preset; otherwise editor.
    raw_perms = payload.get("permissions")
    if isinstance(raw_perms, dict):
        permissions = _normalize_permissions(raw_perms)
    else:
        preset = (payload.get("preset") or "editor").lower()
        permissions = dict(PERMISSION_PRESETS.get(preset, PERMISSION_PRESETS["editor"]))

    db = get_db()
    uid = user["uid"]
    token = secrets.token_urlsafe(24)
    invite_doc = {
        "token": token,
        "email": email,
        "owner_uid": uid,
        "inviter_email": user.get("email") or "",
        "role": "editor",
        "permissions": permissions,
        "accepted": False,
        "created_at": gcfs.SERVER_TIMESTAMP,
    }
    db.collection("invites").document(token).set(invite_doc)

    # If the invited email already has a Firebase account, provision the
    # workspace_members row now. This makes shared data visible immediately
    # on the invitee's next sign-in without requiring them to click the
    # accept link (though the link still works and is idempotent).
    auto_provisioned = False
    try:
        from firebase_admin import auth as fb_auth  # lazy import
        try:
            member_record = fb_auth.get_user_by_email(email)
            member_uid = member_record.uid
            db.collection("workspace_members").document(f"{uid}_{member_uid}").set({
                "owner_uid": uid,
                "member_uid": member_uid,
                "email": email,
                "role": "editor",
                "permissions": permissions,
                "created_at": gcfs.SERVER_TIMESTAMP,
            }, merge=True)
            db.collection("invites").document(token).update({
                "accepted": True,
                "accepted_at": gcfs.SERVER_TIMESTAMP,
                "accepted_by_uid": member_uid,
                "auto_provisioned": True,
            })
            auto_provisioned = True
        except fb_auth.UserNotFoundError:
            # Invitee hasn't signed up yet. The click-to-accept flow will
            # handle provisioning once they sign in.
            pass
    except Exception:
        log.exception("auto-provision invite failed email=%s owner=%s", email, uid)

    accept_url = f"{origin}/invite/{token}"
    own_snap = db.collection("users").document(uid).get()
    workspace_name = (own_snap.to_dict() or {}).get("workspace_name") or (user.get("email") or "Workspace")
    emailed = _send_invite_email(email, accept_url, user.get("email") or "A collaborator", workspace_name)
    return {
        "token": token,
        "accept_url": accept_url,
        "emailed": emailed,
        "auto_provisioned": auto_provisioned,
    }


@app.post("/api/workspace/invites/{token}/reprovision")
def reprovision_invite(token: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    """Force-provision a pending invite if the invitee already has a Firebase
    account. Callable by the invite owner to heal invites that were created
    before auto-provisioning landed. Idempotent."""
    db = get_db()
    ref = db.collection("invites").document(token)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Invite not found")
    data = snap.to_dict() or {}
    if data.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not your invite")
    email = (data.get("email") or "").lower()
    if not email:
        raise HTTPException(status_code=400, detail="Malformed invite")
    try:
        from firebase_admin import auth as fb_auth
        try:
            member_record = fb_auth.get_user_by_email(email)
        except fb_auth.UserNotFoundError:
            return {"ok": False, "reason": "no_firebase_account", "email": email}
        member_uid = member_record.uid
        owner_uid = user["uid"]
        db.collection("workspace_members").document(f"{owner_uid}_{member_uid}").set({
            "owner_uid": owner_uid,
            "member_uid": member_uid,
            "email": email,
            "role": data.get("role") or "editor",
            "permissions": _normalize_permissions(data.get("permissions")),
            "created_at": gcfs.SERVER_TIMESTAMP,
        }, merge=True)
        ref.update({
            "accepted": True,
            "accepted_at": gcfs.SERVER_TIMESTAMP,
            "accepted_by_uid": member_uid,
            "auto_provisioned": True,
        })
        return {"ok": True, "member_uid": member_uid, "email": email}
    except HTTPException:
        raise
    except Exception as e:
        log.exception("reprovision failed token=%s", token)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/workspace/invites/{token}/accept")
def accept_invite(token: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    db = get_db()
    ref = db.collection("invites").document(token)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Invite not found or expired")
    data = snap.to_dict() or {}
    if data.get("accepted"):
        # Idempotent if the same user accepts twice.
        pass
    invitee_email = (data.get("email") or "").lower()
    caller_email = (user.get("email") or "").lower()
    if invitee_email and caller_email and invitee_email != caller_email:
        raise HTTPException(
            status_code=403,
            detail=f"This invite is for {invitee_email}. Sign in with that account to accept.",
        )
    owner_uid = data.get("owner_uid")
    if not owner_uid:
        raise HTTPException(status_code=400, detail="Malformed invite")
    member_uid = user["uid"]
    if owner_uid == member_uid:
        raise HTTPException(status_code=400, detail="You already own this workspace")

    # Create the membership doc. id = {owner}_{member} for O(1) lookup.
    db.collection("workspace_members").document(f"{owner_uid}_{member_uid}").set({
        "owner_uid": owner_uid,
        "member_uid": member_uid,
        "email": user.get("email") or invitee_email,
        "role": data.get("role") or "editor",
        "permissions": _normalize_permissions(data.get("permissions")),
        "created_at": gcfs.SERVER_TIMESTAMP,
    })

    # Point the invitee's profile at this workspace so their queries go there.
    db.collection("users").document(member_uid).set({
        "email": user.get("email"),
        "workspace_owner_uid": owner_uid,
        "updated_at": gcfs.SERVER_TIMESTAMP,
    }, merge=True)

    ref.update({"accepted": True, "accepted_at": gcfs.SERVER_TIMESTAMP, "accepted_by_uid": member_uid})
    return {"ok": True, "workspace_owner_uid": owner_uid}


@app.patch("/api/workspace/members/{member_uid}")
def update_member_permissions(
    member_uid: str,
    payload: dict[str, Any],
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    """Owner updates a member's permissions. Body: {permissions: {...}} OR {preset: 'editor'}."""
    db = get_db()
    owner_uid = user["uid"]
    ref = db.collection("workspace_members").document(f"{owner_uid}_{member_uid}")
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Member not found")

    if isinstance(payload.get("permissions"), dict):
        new_perms = _normalize_permissions(payload["permissions"])
    elif payload.get("preset"):
        preset = payload["preset"].lower()
        new_perms = dict(PERMISSION_PRESETS.get(preset, PERMISSION_PRESETS["editor"]))
    else:
        raise HTTPException(status_code=400, detail="Provide 'permissions' or 'preset'")

    ref.update({"permissions": new_perms, "updated_at": gcfs.SERVER_TIMESTAMP})
    return {"ok": True, "permissions": new_perms}


@app.delete("/api/workspace/members/{member_uid}")
def remove_member(member_uid: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    db = get_db()
    uid = user["uid"]
    mref = db.collection("workspace_members").document(f"{uid}_{member_uid}")
    msnap = mref.get()
    if not msnap.exists:
        raise HTTPException(status_code=404, detail="Member not found")
    mref.delete()
    # Reset the removed user's workspace pointer to themselves.
    db.collection("users").document(member_uid).set({
        "workspace_owner_uid": member_uid,
        "updated_at": gcfs.SERVER_TIMESTAMP,
    }, merge=True)
    return {"ok": True}


@app.delete("/api/workspace/invites/{token}")
def revoke_invite(token: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    db = get_db()
    ref = db.collection("invites").document(token)
    snap = ref.get()
    if not snap.exists:
        return {"ok": True}
    data = snap.to_dict() or {}
    if data.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not your invite")
    ref.delete()
    return {"ok": True}


@app.post("/api/workspace/leave")
def leave_workspace(user: dict = Depends(require_user)) -> dict[str, Any]:
    """Invited user leaves the workspace they belong to (if any)."""
    db = get_db()
    uid = user["uid"]
    udoc = db.collection("users").document(uid).get()
    ws = (udoc.to_dict() or {}).get("workspace_owner_uid")
    if not ws or ws == uid:
        return {"ok": True, "note": "not a member of another workspace"}
    db.collection("workspace_members").document(f"{ws}_{uid}").delete()
    db.collection("users").document(uid).set({
        "workspace_owner_uid": uid,
        "updated_at": gcfs.SERVER_TIMESTAMP,
    }, merge=True)
    return {"ok": True}


# ---------- Delete building / contact with cascade ----------


@app.delete("/api/buildings/{building_id}")
def delete_building(building_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    """Hard-delete a building + cascade: underwriting versions, deals attached to this
    building only, OM ingestions, and unlink from contacts' related_buildings."""
    db = get_db()
    bref = db.collection("buildings").document(building_id)
    snap = bref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Building not found")
    owner = (snap.to_dict() or {}).get("owner_uid")
    if owner and not _can_access(user["uid"], owner):
        raise HTTPException(status_code=404, detail="Building not found")
    if owner:
        _require_permission(user["uid"], owner, "delete")

    removed: dict[str, int] = {"underwriting": 0, "deals": 0, "om_ingestions": 0, "contact_links": 0}

    # Underwriting
    for uw in db.collection("underwriting").where(
        filter=gcfs.FieldFilter("building_id", "==", building_id)
    ).stream():
        uw.reference.delete()
        removed["underwriting"] += 1

    # Deals
    for d in db.collection("deals").where(
        filter=gcfs.FieldFilter("building_id", "==", building_id)
    ).stream():
        d.reference.delete()
        removed["deals"] += 1

    # OM ingestions
    for ing in db.collection("om_ingestions").where(
        filter=gcfs.FieldFilter("building_id", "==", building_id)
    ).stream():
        ing.reference.delete()
        removed["om_ingestions"] += 1

    # Unlink from contacts
    for c in db.collection("contacts").where(
        filter=gcfs.FieldFilter("related_buildings", "array-contains", building_id)
    ).stream():
        data = c.to_dict() or {}
        related = [x for x in (data.get("related_buildings") or []) if x != building_id]
        c.reference.update({"related_buildings": related, "updated_at": gcfs.SERVER_TIMESTAMP})
        removed["contact_links"] += 1

    # Finally the building itself.
    bref.delete()
    return {"ok": True, "building_id": building_id, "removed": removed}


@app.delete("/api/contacts/{contact_id}")
def delete_contact(contact_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    """Hard-delete a contact + cascade: remove the contact id from any deal's contact_ids.
    Buildings are unaffected (contacts link to buildings, not the other way)."""
    db = get_db()
    cref = db.collection("contacts").document(contact_id)
    snap = cref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Contact not found")
    owner = (snap.to_dict() or {}).get("owner_uid")
    if owner and not _can_access(user["uid"], owner):
        raise HTTPException(status_code=404, detail="Contact not found")
    if owner:
        _require_permission(user["uid"], owner, "delete")

    removed = {"deal_links": 0}
    for d in db.collection("deals").where(
        filter=gcfs.FieldFilter("contact_ids", "array-contains", contact_id)
    ).stream():
        data = d.to_dict() or {}
        ids = [x for x in (data.get("contact_ids") or []) if x != contact_id]
        d.reference.update({"contact_ids": ids, "updated_at": gcfs.SERVER_TIMESTAMP})
        removed["deal_links"] += 1

    cref.delete()
    return {"ok": True, "contact_id": contact_id, "removed": removed}


# ---------- One-time migration: stamp owner_uid on legacy docs ----------


@app.post("/api/admin/migrate")
def migrate_ownerless(user: dict = Depends(require_user)) -> dict[str, Any]:
    db = get_db()
    uid = user["uid"]
    stamped: dict[str, int] = {}
    for coll in ("buildings", "contacts", "deals", "underwriting", "om_ingestions"):
        n = 0
        for doc in db.collection(coll).stream():
            data = doc.to_dict() or {}
            if not data.get("owner_uid"):
                db.collection(coll).document(doc.id).update({"owner_uid": uid})
                n += 1
        stamped[coll] = n
    log.info("migrate_ownerless uid=%s stamped=%s", uid, stamped)
    return {"ok": True, "stamped": stamped, "claimed_by": uid}


# ---------- Bulk delete + deals purge ----------


@app.post("/api/buildings/bulk-delete")
def bulk_delete_buildings(
    payload: dict[str, Any],
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    ids = [str(x) for x in (payload.get("ids") or []) if x]
    if not ids:
        return {"ok": True, "deleted": 0, "cascade": {}, "errors": []}
    db = get_db()
    cascade = {"buildings": 0, "underwriting": 0, "deals": 0, "om_ingestions": 0, "contact_links": 0}
    errors: list[dict[str, str]] = []
    for bid in ids:
        try:
            snap = db.collection("buildings").document(bid).get()
            if not snap.exists:
                continue
            owner = (snap.to_dict() or {}).get("owner_uid")
            if owner and not _can_access(user["uid"], owner):
                errors.append({"id": bid, "error": "not_authorized"})
                continue
            if owner and not _permissions_for(user["uid"], owner).get("delete"):
                errors.append({"id": bid, "error": "missing_delete_permission"})
                continue
            # Cascade children. Swallow per-child errors so one bad doc doesn't
            # kill the whole operation; we still want to delete the building.
            try:
                for uw in db.collection("underwriting").where(
                    filter=gcfs.FieldFilter("building_id", "==", bid)
                ).stream():
                    uw.reference.delete()
                    cascade["underwriting"] += 1
            except Exception:
                log.exception("bulk_delete underwriting cascade failed bid=%s", bid)
            try:
                for d in db.collection("deals").where(
                    filter=gcfs.FieldFilter("building_id", "==", bid)
                ).stream():
                    d.reference.delete()
                    cascade["deals"] += 1
            except Exception:
                log.exception("bulk_delete deals cascade failed bid=%s", bid)
            try:
                for ing in db.collection("om_ingestions").where(
                    filter=gcfs.FieldFilter("building_id", "==", bid)
                ).stream():
                    ing.reference.delete()
                    cascade["om_ingestions"] += 1
            except Exception:
                log.exception("bulk_delete om_ingestions cascade failed bid=%s", bid)
            try:
                for c in db.collection("contacts").where(
                    filter=gcfs.FieldFilter("related_buildings", "array-contains", bid)
                ).stream():
                    data = c.to_dict() or {}
                    related = [x for x in (data.get("related_buildings") or []) if x != bid]
                    c.reference.update({"related_buildings": related, "updated_at": gcfs.SERVER_TIMESTAMP})
                    cascade["contact_links"] += 1
            except Exception:
                log.exception("bulk_delete contact link cascade failed bid=%s", bid)
            snap.reference.delete()
            cascade["buildings"] += 1
        except Exception as e:
            log.exception("bulk_delete building failed bid=%s", bid)
            errors.append({"id": bid, "error": str(e)[:200]})
    return {"ok": True, "deleted": cascade["buildings"], "cascade": cascade, "errors": errors}


@app.post("/api/contacts/bulk-delete")
def bulk_delete_contacts(
    payload: dict[str, Any],
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    ids = [str(x) for x in (payload.get("ids") or []) if x]
    if not ids:
        return {"ok": True, "deleted": 0, "cascade": {}, "errors": []}
    db = get_db()
    cascade = {"contacts": 0, "deal_links": 0}
    errors: list[dict[str, str]] = []
    for cid in ids:
        try:
            snap = db.collection("contacts").document(cid).get()
            if not snap.exists:
                continue
            owner = (snap.to_dict() or {}).get("owner_uid")
            if owner and not _can_access(user["uid"], owner):
                errors.append({"id": cid, "error": "not_authorized"})
                continue
            if owner and not _permissions_for(user["uid"], owner).get("delete"):
                errors.append({"id": cid, "error": "missing_delete_permission"})
                continue
            try:
                for d in db.collection("deals").where(
                    filter=gcfs.FieldFilter("contact_ids", "array-contains", cid)
                ).stream():
                    data = d.to_dict() or {}
                    cids = [x for x in (data.get("contact_ids") or []) if x != cid]
                    d.reference.update({"contact_ids": cids, "updated_at": gcfs.SERVER_TIMESTAMP})
                    cascade["deal_links"] += 1
            except Exception:
                log.exception("bulk_delete contact deal-links cascade failed cid=%s", cid)
            snap.reference.delete()
            cascade["contacts"] += 1
        except Exception as e:
            log.exception("bulk_delete contact failed cid=%s", cid)
            errors.append({"id": cid, "error": str(e)[:200]})
    return {"ok": True, "deleted": cascade["contacts"], "cascade": cascade, "errors": errors}


@app.post("/api/deals/purge")
def purge_deals(
    payload: dict[str, Any] | None = None,
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    """Hard-delete every deal doc in the caller's active workspace."""
    db = get_db()
    requested = (payload or {}).get("workspace_owner_uid") if payload else None
    ws = requested if (requested and _can_access(user["uid"], requested)) else _effective_workspace(user["uid"])
    n = 0
    for d in db.collection("deals").where(
        filter=gcfs.FieldFilter("owner_uid", "==", ws)
    ).stream():
        d.reference.delete()
        n += 1
    log.info("purge_deals ws=%s removed=%d", ws, n)
    return {"ok": True, "deleted": n, "workspace_owner_uid": ws}


# ---------- Excel export ----------


@app.get("/api/underwriting/{building_id}/export.xlsx")
def export_underwriting_xlsx(building_id: str, user: dict = Depends(require_user)):
    from fastapi.responses import StreamingResponse
    from .xlsx_export import build_underwriting_workbook

    db = get_db()
    b_snap = db.collection("buildings").document(building_id).get()
    if not b_snap.exists:
        raise HTTPException(status_code=404, detail="Building not found")
    building = b_snap.to_dict() or {}
    owner = building.get("owner_uid")
    if owner and not _can_access(user["uid"], owner):
        raise HTTPException(status_code=404, detail="Building not found")
    uw_doc = None
    for uw in db.collection("underwriting").where(
        filter=gcfs.FieldFilter("building_id", "==", building_id)
    ).stream():
        uw_doc = uw.to_dict() or {}
        break
    if not uw_doc:
        # fall back to a fresh default model
        from .underwriting import default_assumptions
        uw_doc = {
            "building_id": building_id,
            "asset_class": building.get("asset_class", "multifamily"),
            "ttm": {"revenue": [], "expenses": [], "noi": 0},
            "proforma_12mo": {"revenue": [], "expenses": [], "noi": 0},
            "assumptions": default_assumptions(building.get("asset_class", "multifamily")),
            "rent_roll": [],
        }
    buf = build_underwriting_workbook(building, uw_doc)
    addr = (building.get("address") or "underwriting").replace("/", "_").replace(" ", "_")[:80]
    fname = f"{addr}_underwriting.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(_, exc: Exception):
    log.exception("Unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": str(exc)})
