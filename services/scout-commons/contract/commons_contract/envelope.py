"""Response envelope shared with the Papr memory API: { code, status, data, error, details, search_id }."""

from __future__ import annotations

from enum import Enum
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class Strict(BaseModel):
    """Base for request models: unknown keys are a 400, never silently ignored."""

    model_config = ConfigDict(extra="forbid")


class ErrorCode(str, Enum):
    invalid_request = "invalid_request"
    unknown_field = "unknown_field"
    unauthorized = "unauthorized"
    quota_exceeded = "quota_exceeded"
    not_found = "not_found"
    rate_limited = "rate_limited"
    internal = "internal"


class Scope(BaseModel):
    """Request-level scoping, same names as the memory API. Used for quotas only, never logged with entities."""

    external_user_id: str | None = None
    organization_id: str | None = None
    namespace_id: str | None = None


class Envelope(BaseModel, Generic[T]):
    code: int = 200
    status: Literal["success", "accepted", "error"] = "success"
    data: T | None = None
    error: ErrorCode | None = None
    details: dict[str, Any] | None = None
    search_id: str | None = Field(None, description="Only on /search; pass to POST /v1/feedback.")
