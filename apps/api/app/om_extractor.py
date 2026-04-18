"""OM extraction via Gemini 2.5 Pro vision.

Input: list of documents (PDFs or images) represented as (filename, bytes, mime).
Output: structured JSON with building, contacts, and TTM financials.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Iterable

from google import genai
from google.genai import types

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
    "ttm_period": {
      "start_month": string like "2024-05",
      "end_month": string like "2025-04",
      "label": string like "T12 Apr 2024 - Mar 2025"
    },
    "ttm": {
      "revenue": [ { "label": string, "amount": number } ],
      "expenses": [ { "label": string, "amount": number } ]
    },
    "ttm_monthly": {
      "months": [ string like "2024-05", "2024-06", ... ] (exactly 12 entries, oldest first),
      "revenue": [ { "label": string, "amounts": [number, number, ... 12 numbers] } ],
      "expenses": [ { "label": string, "amounts": [number, number, ... 12 numbers] } ]
    },
    "proforma_12mo": {
      "months": [ string like "2025-05", ... ] (exactly 12 entries, starting the month after ttm_monthly ends),
      "revenue": [ { "label": string, "amounts": [number, ... 12 numbers] } ],
      "expenses": [ { "label": string, "amounts": [number, ... 12 numbers] } ]
    }
  }
}

Rules:
- Prefer T12 actuals when the OM shows them. If only proforma is shown, extract proforma and note that in building.notes.
- Always fill `ttm.revenue` and `ttm.expenses` with annual totals per line. `ttm_monthly` is the month-by-month breakdown if the OM provides monthly P&L or trailing-12 schedule. Skip `ttm_monthly` entirely if no monthly data is shown; do not evenly divide annual numbers.
- If the OM includes a sponsor's year-1 proforma with monthly schedule, capture it in `proforma_12mo`. If the OM shows only an annual proforma, skip `proforma_12mo`.
- Line item `label` must match across `ttm` and `ttm_monthly` (same category names, same order). Same for `proforma_12mo` if included.
- Annual amount per line should equal the sum of its 12 monthly values (within rounding).
- Convert all monetary values to absolute USD, no thousands separators or currency symbols.
- Express percentages as decimals (7.5 percent becomes 0.075).
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


def _coerce_json(text: str) -> dict[str, Any]:
    text = text.strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return json.loads(text[start : end + 1])
    raise ValueError("Model did not return JSON")


def extract_from_documents(
    docs: Iterable[tuple[str, bytes, str | None]],
    api_key: str | None = None,
) -> dict[str, Any]:
    """Run Gemini 2.5 Pro vision extraction across one or more documents.

    api_key: per-user key from Firestore. Falls back to settings.gemini_api_key
    (Secret Manager) if the per-user key is not set.
    """
    key = api_key or settings.gemini_api_key
    if not key:
        raise RuntimeError(
            "No Gemini API key. Add your key on the Settings page before uploading an OM."
        )
    client = genai.Client(api_key=key)

    parts: list[Any] = []
    for name, raw, mime in docs:
        media_type = _media_type_for(name, mime)
        parts.append(types.Part.from_bytes(data=raw, mime_type=media_type))
    parts.append(
        "Extract the OM data now. Return STRICT JSON that matches the schema. Do not include any text outside the JSON object."
    )

    response = client.models.generate_content(
        model=settings.gemini_model,
        contents=parts,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
            max_output_tokens=32768,
        ),
    )
    text = response.text or ""
    log.info("OM extraction received %d chars from model %s", len(text), settings.gemini_model)
    return _coerce_json(text)
