"""Auth dependency: verifies a Firebase ID token. No email allowlist (multi-tenant)."""
from __future__ import annotations

import os
from fastapi import Header, HTTPException, status

from .firebase_admin_client import verify_id_token


async def require_user(authorization: str | None = Header(default=None)) -> dict:
    if os.getenv("AUTH_DISABLED") == "1":
        return {"email": "dev@local", "uid": "dev"}
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        claims = verify_id_token(token)
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {exc}") from exc
    uid = claims.get("uid") or claims.get("user_id") or claims.get("sub")
    if not uid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token missing uid")
    email = (claims.get("email") or "").strip()
    return {"email": email, "uid": uid}
