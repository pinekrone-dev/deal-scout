"""Deal Scout CRM backend. FastAPI + Firestore + Claude vision OM ingestion."""
from __future__ import annotations

import asyncio
import logging
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


# ---------- Ingest ----------


@app.post("/api/ingest")
async def create_ingest(
    background: BackgroundTasks,
    files: list[UploadFile] = File(...),
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

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

    background.add_task(_run_extraction, ingestion_id, doc_payload)
    return {"ingestion_id": ingestion_id}


def _run_extraction(ingestion_id: str, docs: list[tuple[str, bytes, str]]) -> None:
    db = get_db()
    ref = db.collection("om_ingestions").document(ingestion_id)
    ref.update({"extraction_status": "running"})
    try:
        extracted = extract_from_documents(docs)
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
    db = get_db()
    ingest_ref = db.collection("om_ingestions").document(ingestion_id)
    ingest_snap = ingest_ref.get()
    if not ingest_snap.exists:
        raise HTTPException(status_code=404, detail="Ingestion not found")

    building_in = payload.get("building") or {}
    if not building_in.get("address"):
        raise HTTPException(status_code=400, detail="Building address is required")

    asset_class = building_in.get("asset_class") or "multifamily"
    building_doc = {
        "address": building_in.get("address"),
        "city": building_in.get("city"),
        "state": building_in.get("state"),
        "zip": building_in.get("zip"),
        "asset_class": asset_class,
        "units": building_in.get("units"),
        "sf": building_in.get("sf"),
        "nrsf": building_in.get("nrsf"),
        "keys": building_in.get("keys"),
        "zoning": building_in.get("zoning"),
        "entitlements": building_in.get("entitlements"),
        "year_built": building_in.get("year_built"),
        "year_renovated": building_in.get("year_renovated"),
        "occupancy": building_in.get("occupancy"),
        "current_noi": building_in.get("current_noi"),
        "asking_price": building_in.get("asking_price"),
        "cap_rate": building_in.get("cap_rate"),
        "adr": building_in.get("adr"),
        "revpar": building_in.get("revpar"),
        "notes": building_in.get("notes"),
        "photos": [],
        "documents": [
            f"gs://{settings.firebase_storage_bucket}/{p}"
            for p in (ingest_snap.to_dict() or {}).get("storage_path", []) or []
        ],
        "created_at": gcfs.SERVER_TIMESTAMP,
        "updated_at": gcfs.SERVER_TIMESTAMP,
    }
    building_ref = db.collection("buildings").document()
    building_ref.set(building_doc)
    building_id = building_ref.id

    contact_ids: list[str] = []
    for c in payload.get("contacts") or []:
        if not c.get("name"):
            continue
        contact_ref = db.collection("contacts").document()
        contact_ref.set(
            {
                "name": c.get("name"),
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
            }
        )
        contact_ids.append(contact_ref.id)

    financials = payload.get("financials") or {}
    ttm = financials.get("ttm") or {"revenue": [], "expenses": []}
    ttm["noi"] = compute_noi(ttm)
    assumptions = default_assumptions(asset_class)
    proforma = build_proforma_from_ttm(ttm, assumptions)
    returns = compute_returns(building_doc, ttm, proforma, assumptions)

    uw_ref = db.collection("underwriting").document()
    uw_ref.set(
        {
            "building_id": building_id,
            "asset_class": asset_class,
            "ttm": ttm,
            "proforma_12mo": proforma,
            "assumptions": assumptions,
            "returns": {
                "irr": returns.irr,
                "equity_multiple": returns.equity_multiple,
                "coc_yr1": returns.coc_yr1,
                "dscr": returns.dscr,
            },
            "version": 1,
            "created_at": gcfs.SERVER_TIMESTAMP,
        }
    )

    ingest_ref.update(
        {
            "building_id": building_id,
            "confirmed_at": gcfs.SERVER_TIMESTAMP,
        }
    )

    return {"building_id": building_id, "contact_ids": contact_ids, "underwriting_id": uw_ref.id}


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
        "returns": {
            "irr": returns.irr,
            "equity_multiple": returns.equity_multiple,
            "coc_yr1": returns.coc_yr1,
            "dscr": returns.dscr,
        },
    }


@app.exception_handler(Exception)
async def unhandled_exception_handler(_, exc: Exception):  # pragma: no cover - catch-all
    log.exception("Unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": str(exc)})
