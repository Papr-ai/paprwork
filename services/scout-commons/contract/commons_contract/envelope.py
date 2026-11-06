"""Response envelope shared with the Papr memory API: { code, status, data, error, details, search_id },
plus request_id, warnings and notices (borrowed from Exa's API)."""

from __future__ import annotations

import re
from enum import Enum
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator

T = TypeVar("T")

MAX_AGE_DOC = (
    "Freshness the caller needs, in hours (max 8760). Stored facts younger than this are served; older ones "
    "are refreshed live within the time limit. 0 = always refresh live (subject to quotas). "
    "-1 = never compute live: batch only, misses come back with coverage: pending. "
    "Omitted = serve stored facts, refresh live only for misses and facts past their default max age (§5.4)."
)


class Strict(BaseModel):
    """Base for request models: unknown keys are a 400, never silently ignored."""

    model_config = ConfigDict(extra="forbid")


class ErrorCode(str, Enum):
    """Known error codes. The set is open: clients branch on HTTP status first and treat unknown codes as generic."""

    invalid_request = "invalid_request"            # 400
    unknown_field = "unknown_field"                # 400
    unauthorized = "unauthorized"                  # 401
    live_budget_exceeded = "live_budget_exceeded"  # 402: per-install or global live-compute cap; Retry-After set
    forbidden = "forbidden"                        # 403
    not_found = "not_found"                        # 404
    rate_limited = "rate_limited"                  # 429: Retry-After set
    internal = "internal"                          # 500
    service_unavailable = "service_unavailable"    # 503: not processed, not counted against quotas


class Message(BaseModel):
    code: str = Field(description="UPPER_SNAKE. Open set: tolerate codes you don't recognize.")
    path: str | None = Field(None, description="JSON Pointer to the request field this is about, e.g. /filters/uses.")
    message: str = Field(description="Complete on its own.")


KNOWN_WARNINGS = {
    "IGNORED_FIELD": "The field at path is accepted and has no effect.",
    "FIELD_NOT_IN_VECTOR_STORE": "This filter isn't copied into Qdrant, so it ran as an exact pre-filter in MongoDB.",
    "SEED_NOT_FOUND": "A seed couldn't be resolved to a company; it was skipped.",
}
KNOWN_NOTICES = {
    "EMBEDDING_ONLY_LOOKALIKES": "A seed has no web-graph lookalikes; results come from embedding neighbours.",
    "COMPUTED_LIVE": "Some records were computed live (provisional, confidence: lower).",
    "STALE_SERVED": "Some facts are past their max age; served with stale: true and refreshing.",
    "PARTIAL_COVERAGE": "Some fields are still computing (coverage: partial | pending).",
}


class Scope(BaseModel):
    """Request-level scoping, same names as the memory API."""

    external_user_id: str | None = Field(
        None, max_length=128,
        description="Opaque ID your app assigns to the end user (e.g. a UUID), used for per-user quotas. "
                    "Must not contain personal information: no email, phone, username or name. "
                    "Never logged alongside the entities in the request.",
    )
    organization_id: str | None = None
    namespace_id: str | None = None

    @field_validator("external_user_id")
    @classmethod
    def _opaque(cls, v: str | None) -> str | None:
        if v is not None and (not re.fullmatch(r"[A-Za-z0-9_\-:.]+", v) or "@" in v):
            raise ValueError("external_user_id must be an opaque ID (letters, digits, _-:.), not personal information")
        return v


class Envelope(BaseModel, Generic[T]):
    code: int = 200
    status: Literal["success", "accepted", "error"] = "success"
    request_id: str = Field(description="Unique per request. Include it when reporting a problem.")
    data: T | None = None
    error: str | None = Field(None, description="Machine-readable code; open set, known values in ErrorCode.")
    details: dict[str, Any] | None = Field(None, description="On errors: { message, path? }.")
    search_id: str | None = Field(None, description="Only on /search; pass to POST /v1/feedback.")
    warnings: list[Message] = Field(default_factory=list, description="About the request. Log them; don't show them to a model.")
    notices: list[Message] = Field(default_factory=list, description="How results were produced. Pass them to the model or user with the results.")
