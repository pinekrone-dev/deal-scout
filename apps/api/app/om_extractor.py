"""OM extraction via Claude Sonnet 4.6 vision.

Input: list of documents (PDFs or images) represented as (filename, bytes, mime).
Output: structured JSON with building, contacts, and TTM financials.
"""
from __future__ import annotations

import base64
import json
import logging
import re
from typing import Any, Iterable

from anthropic import Anthropic

from .config import settings

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a real estate analyst. Extract structured data from commercial real estate Offering Memoranda (OMs).
Return STRICT JSON only. No prose, no code fences.

Fields to extract (omit any that are not present; never invent values):

{
  "building": {
    "address": string,
    "city": string,
    "state": string,
    "zip": string,
    "asset_class": one of [multifamily, office, retail, industrial, hospitality, mixed-use, land, self-storage, other],
    "units": integer,
    "sf": integer,
    "nrsf": integer,
    "keys": integer,
    "zoning": string,
    "entitlements": string,
    "year_built": integer,
    "year_renovated": integer,
    "occupancy": number between 0 and 1,
    "current_noi": number,
    "asking_price": number,
    "cap_rate": number between 0 and 1,
    "adr": number,
    "revpar": number,
    "notes": short string summarizing key callouts
  },
  "contacts": [
    { "name": string, "role": one of [broker, sponsor, owner, lender, tenant, other], "firm": string, "email": string, "phone": string }
  ],
  "financials": {
    "ttm": {
      "revenue": [ { "label": string, "amount": number } ],
      "expenses": [ { "label": string, "amount": number } ]
    }
  }
}

Rules:
- Prefer T12 actuals when the OM shows them. If only proforma is shown, extract proforma and note that in building.notes.
- Convert all monetary values to absolute USD, no thousands separators or currency symbols.
- Express percentages as decimals (7.5% => 0.075).
- If the asset class is not explicit, infer from unit count, SF, hospitality language, or storage language. Default to multifamily only if unit count is present without conflicting signals.
- If fields are unknown, omit them. Never fabricate a broker name or price.
"""


def _media_type_for(filename: str, mime: str | None) -> str:
    if mime:
        return mime
    lower = filename.lower()
    if lower.endswith(".pdf"):
        return "application/pdf"
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith(".jpg") or lower.endswith(".jpeg"):
        return "image/jpeg"
    if lower.endswith(".webp"):
        return "image/webp"
    if lower.endswith(".gif"):
        return "image/gif"
    return "application/octet-stream"


def _content_block(name: str, raw: bytes, mime: str) -> dict[str, Any]:
    b64 = base64.standard_b64encode(raw).decode("ascii")
    if mime == "application/pdf":
        return {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": b64},
            "title": name,
        }
    if mime.startswith("image/"):
        return {
            "type": "image",
            "source": {"type": "base64", "media_type": mime, "data": b64},
        }
    raise ValueError(f"Unsupported media type for Claude vision: {mime}")


def _coerce_json(text: str) -> dict[str, Any]:
    text = text.strip()
    # Strip code fences if the model slips one in.
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    # Try straight parse first.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Find the outermost JSON object.
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return json.loads(text[start : end + 1])
    raise ValueError("Model did not return JSON")


def extract_from_documents(
    docs: Iterable[tuple[str, bytes, str | None]],
) -> dict[str, Any]:
    """Run Claude Sonnet 4.6 vision extraction across one or more documents."""
    if not settings.anthropic_api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    client = Anthropic(api_key=settings.anthropic_api_key)

    content: list[dict[str, Any]] = []
    for name, raw, mime in docs:
        media_type = _media_type_for(name, mime)
        content.append(_content_block(name, raw, media_type))
    content.append(
        {
            "type": "text",
            "text": "Extract the OM data now. Return STRICT JSON that matches the schema. Do not include any text outside the JSON object.",
        }
    )

    message = client.messages.create(
        model=settings.anthropic_model,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": content}],
    )
    text_parts: list[str] = []
    for block in message.content:
        if getattr(block, "type", None) == "text":
            text_parts.append(block.text)
    joined = "\n".join(text_parts)
    log.info("OM extraction received %d chars from model %s", len(joined), settings.anthropic_model)
    return _coerce_json(joined)
