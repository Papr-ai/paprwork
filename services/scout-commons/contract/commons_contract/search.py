"""POST /v1/commons/search: semantic, lookalike, or both (§7.1)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .envelope import Scope, Strict
from .filters import Entity, Exclude, Filters, check_duration


class RerankingConfig(Strict):
    reranking_provider: Literal["none", "cohere", "openai", "papr_enhanced", "papr_max"] = "none"
    reranking_model: str | None = None


class SearchRequest(Strict, Scope):
    entity: Entity = "company"
    query: str | None = Field(None, min_length=2, max_length=2000)
    seeds: list[str] = Field(default_factory=list, max_length=50, description="Entity IDs or domains.")
    query_weight: float = Field(0.5, ge=0, le=1, description="Blend when both query and seeds are given.")
    filters: Filters = Field(default_factory=Filters)
    exclude: Exclude = Field(default_factory=Exclude)
    reranking_config: RerankingConfig = Field(default_factory=RerankingConfig)
    min_score: float = Field(0, ge=0, le=1)
    explain: bool = False
    fields: list[str] = Field(default_factory=lambda: ["domain", "name"])
    max_age: str | None = Field(None, description="Freshness the caller needs, e.g. 30d.")
    allow_live: bool = Field(True, description="false = batch only; misses return coverage: pending.")

    _v_age = field_validator("max_age")(lambda v: v if v is None else check_duration(v))

    @model_validator(mode="after")
    def _needs_meaning(self) -> "SearchRequest":
        if not self.query and not self.seeds:
            raise ValueError("search needs query or seeds; use /v1/commons/filter for filters only")
        return self


class Why(BaseModel):
    matched_text: str | None = None
    seed_overlap: float | None = None
    filters_matched: list[str] = Field(default_factory=list)


class SearchResult(BaseModel):
    entity_id: str
    score: float
    why: Why | None = None
    record: dict[str, Any] = Field(description="Requested fields + every Freshness field.")


class SearchData(BaseModel):
    results: list[SearchResult]
    total_considered: int
    routed: Literal["qdrant", "mongo→qdrant", "precomputed+qdrant"]
    pending_seeds: list[str] = Field(default_factory=list, description="Seeds still computing live; see task_id.")
    task_id: str | None = None
