"""GET /v1/commons/entities/{id} and POST /v1/commons/entities (batch ≤ 1,000)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

from .envelope import Scope, Strict
from .filters import check_duration


class EntitiesRequest(Strict, Scope):
    ids: list[str] = Field(min_length=1, max_length=1000, description="Entity IDs or domains (normalized).")
    fields: list[str] = Field(default_factory=lambda: ["*"])
    updated_since: datetime | None = Field(None, description="Return only entities that changed since.")
    max_age: str | None = None
    allow_live: bool = True

    _v_age = field_validator("max_age")(lambda v: v if v is None else check_duration(v))


class EntitiesData(BaseModel):
    results: list[dict[str, Any]] = Field(description="Found or provisional records, each with Freshness fields.")
    not_found: list[str] = Field(default_factory=list, description="Invalid domains, or allow_live=false misses.")
    pending: list[str] = Field(default_factory=list, description="Misses computing live; poll task_id or await ready event.")
    task_id: str | None = None
