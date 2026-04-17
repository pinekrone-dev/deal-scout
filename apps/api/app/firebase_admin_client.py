"""Firebase Admin initialization. Safe to import multiple times."""
from __future__ import annotations

import threading
from typing import Optional

import firebase_admin
from firebase_admin import credentials, firestore, storage

from .config import settings

_lock = threading.Lock()
_initialized = False


def _ensure_initialized() -> None:
    global _initialized
    if _initialized:
        return
    with _lock:
        if _initialized:
            return
        if not firebase_admin._apps:  # type: ignore[attr-defined]
            cred: Optional[credentials.Base] = None
            try:
                cred = credentials.ApplicationDefault()
            except Exception:
                cred = None
            init_opts = {
                "projectId": settings.firebase_project_id,
                "storageBucket": settings.firebase_storage_bucket,
            }
            if cred is not None:
                firebase_admin.initialize_app(cred, init_opts)
            else:
                firebase_admin.initialize_app(options=init_opts)
        _initialized = True


def get_db():
    _ensure_initialized()
    return firestore.client()


def get_bucket():
    _ensure_initialized()
    return storage.bucket()


def verify_id_token(id_token: str) -> dict:
    _ensure_initialized()
    from firebase_admin import auth as fb_auth

    return fb_auth.verify_id_token(id_token)
