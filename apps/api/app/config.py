"""Runtime configuration pulled from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass


def _csv(name: str, default: str = "") -> list[str]:
    raw = os.getenv(name, default)
    return [s.strip() for s in raw.split(",") if s.strip()]


@dataclass(frozen=True)
class Settings:
    anthropic_api_key: str
    anthropic_model: str
    firebase_project_id: str
    firebase_storage_bucket: str
    allowed_origins: list[str]
    allowed_emails: list[str]
    allowed_domains: list[str]


def load_settings() -> Settings:
    return Settings(
        anthropic_api_key=os.getenv("GEMINI_API_KEY", ""),
        anthropic_model=os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        firebase_project_id=os.getenv("FIREBASE_PROJECT_ID", "reais---prospecter"),
        firebase_storage_bucket=os.getenv("FIREBASE_STORAGE_BUCKET", "reais---prospecter.appspot.com"),
        allowed_origins=_csv(
            "ALLOWED_ORIGINS",
            "https://deal-scout-s4vcjek4ra-uw.a.run.app,http://localhost:5173",
        ),
        allowed_emails=_csv("ALLOWED_EMAILS", "pinekrone@gmail.com"),
        allowed_domains=_csv("ALLOWED_DOMAINS", "realestateaistudio.com"),
    )


settings = load_settings()
