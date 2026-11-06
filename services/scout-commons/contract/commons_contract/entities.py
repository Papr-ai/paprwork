"""GET /v1/commons/entities/{id} and POST /v1/commons/entities (batch ≤ 1,000)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from .envelope import MAX_AGE_DOC, Scope, Strict


class EntitiesRequest(Strict, Scope):
    ids: list[str] = Field(min_length=1, max_length=1000, description="Entity IDs or domains (normalized).")
    fields: list[str] = Field(default_factory=lambda: ["*"])
    updated_since: datetime | None = Field(None, description="Return only entities that changed since.")
    max_age_hours: int | None = Field(None, ge=-1, le=8760, description=MAX_AGE_DOC)


class EntitiesData(BaseModel):
    results: list[dict[str, Any]] = Field(description="Found or provisional records, each with Freshness fields.")
    not_found: list[str] = Field(default_factory=list, description="Invalid domains, or misses when max_age_hours=-1.")
    pending: list[str] = Field(default_factory=list, description="Misses computing live; poll task_id or subscribe to commons.task.completed.")
    task_id: str | None = None
