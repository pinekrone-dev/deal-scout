"""Auth dependency: verifies a Firebase ID token and enforces allowlist."""
from __future__ import annotations

import os
from fastapi import Header, HTTPException, status

from .config import settings
from .firebase_admin_client import verify_id_token


def _is_allowed(email: str) -> bool:
    email_lc = email.lower()
    if email_lc in [e.lower() for e in settings.allowed_emails]:
        return True
    for domain in settings.allowed_domains:
        if email_lc.endswith("@" + domain.lower()):
            return True
    return False


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
    email = (claims.get("email") or "").strip()
    if not email or not _is_allowed(email):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account not authorized")
    return {"email": email, "uid": claims.get("uid", email)}
