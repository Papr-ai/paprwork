"""Record shapes. Every record carries freshness fields (§7.3); no record leaves the API without them."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


class Freshness(BaseModel):
    source: Literal["batch", "live"]
    as_of: datetime
    release: str = Field(description="Release the record was built or computed from, e.g. cc-2026q3.")
    stale: bool = Field(description="Older than this fact's max age; served, but refreshing in the background.")
    provisional: bool = Field(False, description="Not in the release yet; computed live.")
    confidence: Literal["high", "lower"] = "high"
    coverage: Literal["full", "partial", "pending"] = "full"


class DatedVendor(BaseModel):
    vendor: str
    first_seen: date
    last_seen: date
    evidence_url: str | None = Field(None, description="Page where the vendor was detected.")


class OpenRole(BaseModel):
    role: str = Field(description="Normalized role from the fixed list, e.g. SDR, AE, platform_engineer.")
    count: int
    board: str | None = None
    as_of: datetime
    evidence_url: str | None = Field(None, description="Job posting or board page behind this role.")


class Lookalike(BaseModel):
    entity_id: str
    domain: str
    score: float = Field(ge=0, le=1)
    via: Literal["web_graph", "embedding", "blend"]


class Company(Freshness):
    type: Literal["company"] = Field("company", description="Entity discriminator; 'person' arrives in Phase 2.")
    schema_version: int = Field(1, ge=1, description="Bumped on breaking record-shape changes.")
    entity_id: str
    domain: str
    name: str | None = None
    logo: str | None = None
    description: str | None = None
    country: str | None = None
    state: str | None = None
    city: str | None = None
    industry: str | None = None
    size_band: str | None = None
    employees: int | None = None
    authority: float | None = None
    uses: list[DatedVendor] = Field(default_factory=list)
    open_jobs: list[OpenRole] = Field(default_factory=list)
    lookalikes: list[Lookalike] | None = Field(None, description="Top 100; only when requested in fields.")
