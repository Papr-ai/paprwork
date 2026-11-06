"""POST /v1/commons/filter: exact criteria, lists and counts, no vectors (§7.1)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .envelope import Scope, Strict
from .filters import Entity, Exclude, Filters


class Sort(Strict):
    field: str
    order: Literal["asc", "desc"] = "desc"


class FilterRequest(Strict, Scope):
    entity: Entity = "company"
    filters: Filters = Field(default_factory=Filters)
    exclude: Exclude = Field(default_factory=Exclude)
    sort: list[Sort] = Field(default_factory=list, max_length=3)
    facets: list[str] = Field(default_factory=list, max_length=10)
    cursor: str | None = None
    fields: list[str] = Field(default_factory=lambda: ["domain", "name"])


class FilterData(BaseModel):
    results: list[dict[str, Any]]
    total: int
    total_is_estimate: bool = Field(False, description="true once total exceeds 10,000.")
    facets: dict[str, dict[str, int]] = Field(default_factory=dict)
    next_cursor: str | None = None
