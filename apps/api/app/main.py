"""Deal Scout CRM backend. FastAPI + Firestore + Gemini vision OM ingestion."""
from __future__ import annotations

import asyncio
import logging
import math
import os
import uuid
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, UploadFile, status
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

app = FastAPI(title="Deal Scout CRM API", version="0.1.0")

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
    # Permit iframe embedding from Anthropic and Cloud Run frontends.
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
    """Coerce a value to a finite number or None. Accepts ints, floats, numeric strings.
    Rejects NaN, Inf, empty strings, and anything uncoercible. Firestore does NOT accept
    NaN/Inf in float fields: those writes will fail or hang depending on SDK version.
    """
    if v is None:
        return None
    if isinstance(v, bool):
        return None  # bools coerce to 0/1 which we never want here
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
    """Remove None/NaN/Inf values from a dict to keep Firestore docs tidy and safe."""
    out: dict[str, Any] = {}
    for k, v in d.items():
        if v is None:
            continue
        if isinstance(v, float) and not math.isfinite(v):
            continue
        out[k] = v
    return out


def _clean_line_items(items: Any) -> list[dict[str, Any]]:
    """Sanitize a list of {label, amount} line items. Coerces amounts, drops junk."""
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
    """Sanitize a revenue/expenses statement into a shape safe for math + Firestore."""
    if not isinstance(stmt, dict):
        return {"revenue": [], "expenses": []}
    return {
        "revenue": _clean_line_items(stmt.get("revenue")),
        "expenses": _clean_line_items(stmt.get("expenses")),
    }


def _deep_clean(v: Any) -> Any:
    """Recursively remove None/NaN/Inf; keep lists/dicts otherwise."""
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
    """Ensure every returns field is a finite float or None before going to Firestore."""
    return {
        "irr": _num_or_none(r.irr),
        "equity_multiple": _num_or_none(r.equity_multiple),
        "coc_yr1": _num_or_none(r.coc_yr1),
        "dscr": _num_or_none(r.dscr),
    }


# ---------- Ingest ----------


def _user_gemini_key(uid: str) -> str | None:
    """Read the per-user Gemini API key from users/{uid}.gemini_api_key."""
    try:
        snap = get_db().collection("users").document(uid).get()
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
    """Return whether the current user has configured a Gemini key (never the key itself)."""
    key = _user_gemini_key(user["uid"])
    fallback = bool(settings.gemini_api_key)
    return {
        "has_user_key": bool(key),
        "has_fallback_key": fallback,
        "model": settings.gemini_model,
        "email": user.get("email"),
    }


@app.post("/api/settings")
def save_settings(
    payload: dict[str, Any],
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    """Persist the user's Gemini key (or clear it with empty string)."""
    key = payload.get("gemini_api_key")
    if key is not None and not isinstance(key, str):
        raise HTTPException(status_code=400, detail="gemini_api_key must be a string")
    db = get_db()
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


@app.post("/api/ingest")
async def create_ingest(
    background: BackgroundTasks,
    files: list[UploadFile] = File(...),
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    # Require a key before we even upload. Fail fast with a clear message.
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

    db.collection("om_ingestions").document(ingestion_id).set(
        {
            "owner_uid": user["uid"],
            "storage_path": storage_paths,
            "building_id": None,
            "extraction_status": "pending",
            "raw_extraction": None,
            "confirmed_at": None,
            "error": None,
            "created_at": gcfs.SERVER_TIMESTAMP,
            "created_by": user.get("email"),
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
    except Exception as exc:  # pragma: no cover - external service failure path
        log.exception("Extraction failed for %s", ingestion_id)
        ref.update({"extraction_status": "error", "error": str(exc)})


@app.get("/api/ingest/{ingestion_id}")
def get_ingest(ingestion_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    db = get_db()
    snap = db.collection("om_ingestions").document(ingestion_id).get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Ingestion not found")
    data = snap.to_dict() or {}
    if data.get("owner_uid") and data["owner_uid"] != user["uid"]:
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
        if ingest_data.get("owner_uid") and ingest_data["owner_uid"] != user["uid"]:
            raise HTTPException(status_code=404, detail="Ingestion not found")

        building_in = payload.get("building") or {}
        address = (building_in.get("address") or "").strip()
        if not address:
            raise HTTPException(status_code=400, detail="Building address is required")

        asset_class = building_in.get("asset_class") or "multifamily"
        building_doc_raw = {
            "owner_uid": user["uid"],
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
                "owner_uid": user["uid"],
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
        log.info("confirm_ingest wrote %d contacts", len(contact_ids))

        financials = payload.get("financials") or {}
        ttm_raw = financials.get("ttm") or {"revenue": [], "expenses": []}
        log.info(
            "confirm_ingest ttm shape rev=%d exp=%d",
            len(ttm_raw.get("revenue") or []) if isinstance(ttm_raw, dict) else -1,
            len(ttm_raw.get("expenses") or []) if isinstance(ttm_raw, dict) else -1,
        )
        ttm = _clean_statement(ttm_raw)
        try:
            ttm["noi"] = float(compute_noi(ttm))
            if not math.isfinite(ttm["noi"]):
                ttm["noi"] = 0.0
        except Exception:
            log.exception("compute_noi failed, defaulting to 0")
            ttm["noi"] = 0.0

        assumptions = default_assumptions(asset_class)

        uw_id: str | None = None
        try:
            proforma_raw = build_proforma_from_ttm(ttm, assumptions)
            proforma = _clean_statement(proforma_raw)
            proforma["noi"] = float(compute_noi(proforma))
            if not math.isfinite(proforma["noi"]):
                proforma["noi"] = 0.0
            returns = compute_returns(building_doc, ttm, proforma, assumptions)
            uw_payload = _deep_clean({
                "owner_uid": user["uid"],
                "building_id": building_id,
                "asset_class": asset_class,
                "ttm": ttm,
                "proforma_12mo": proforma,
                "assumptions": assumptions,
                "returns": _safe_returns(returns),
                "version": 1,
                "created_at": gcfs.SERVER_TIMESTAMP,
            })
            uw_ref = db.collection("underwriting").document()
            uw_ref.set(uw_payload)
            uw_id = uw_ref.id
            log.info("confirm_ingest wrote underwriting id=%s", uw_id)
        except Exception:
            log.exception("confirm_ingest underwriting math/write failed; building+contacts kept")
            # Write a minimal empty underwriting record so the UI has something to point at.
            try:
                uw_ref = db.collection("underwriting").document()
                uw_ref.set(_deep_clean({
                    "owner_uid": user["uid"],
                    "building_id": building_id,
                    "asset_class": asset_class,
                    "ttm": ttm,
                    "proforma_12mo": {"revenue": [], "expenses": [], "noi": 0.0},
                    "assumptions": assumptions,
                    "returns": {"irr": None, "equity_multiple": None, "coc_yr1": None, "dscr": None},
                    "version": 1,
                    "created_at": gcfs.SERVER_TIMESTAMP,
                    "note": "underwriting math failed at ingest; re-run from the building page",
                }))
                uw_id = uw_ref.id
                log.info("confirm_ingest wrote placeholder underwriting id=%s", uw_id)
            except Exception:
                log.exception("placeholder underwriting write also failed")
                uw_id = None

        ingest_ref.update(
            {
                "building_id": building_id,
                "confirmed_at": gcfs.SERVER_TIMESTAMP,
            }
        )
        log.info("confirm_ingest done id=%s building=%s", ingestion_id, building_id)

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
    if building.get("owner_uid") and building["owner_uid"] != user["uid"]:
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


# ---------- One-time migration: stamp owner_uid on legacy docs ----------


@app.post("/api/admin/migrate")
def migrate_ownerless(user: dict = Depends(require_user)) -> dict[str, Any]:
    """Stamp owner_uid = caller's uid on all docs that have none.
    Only the first user to call this on a legacy doc claims it.
    """
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


@app.exception_handler(Exception)
async def unhandled_exception_handler(_, exc: Exception):  # pragma: no cover - catch-all
    log.exception("Unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": str(exc)})
