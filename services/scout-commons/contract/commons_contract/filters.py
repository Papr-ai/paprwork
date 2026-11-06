"""Shared filter language (§7.1). Same object works in /search, /filter, /entities.

A bare value means equals; a list means any-of; ranges use gte/lte/gt/lt.
Unlike memory's customMetadata, a bare number is equals, never >=.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Annotated, Literal, Union

from pydantic import Field, RootModel, field_validator, model_validator

from .envelope import Strict

Scalar = Union[str, int, float, bool]
_DURATION = re.compile(r"^\d+[dwmy]$")


def check_duration(v: str) -> str:
    if not _DURATION.match(v):
        raise ValueError("durations look like 7d, 4w, 6m or 1y")
    return v


class Range(Strict):
    gte: float | None = None
    lte: float | None = None
    gt: float | None = None
    lt: float | None = None

    @model_validator(mode="after")
    def _non_empty(self) -> "Range":
        if all(v is None for v in (self.gte, self.lte, self.gt, self.lt)):
            raise ValueError("range needs at least one of gte, lte, gt, lt")
        return self


class AllOf(Strict):
    all: list[Scalar] = Field(min_length=1)


class NoneOf(Strict):
    not_: list[Scalar] = Field(alias="not", min_length=1)


class DatedFact(Strict):
    """e.g. tech_added: { vendor: hubspot, since: 90d } — a fact first seen inside the window."""

    vendor: str
    since: Union[date, Annotated[str, Field(pattern=r"^\d+[dwmy]$")]]


Condition = Union[Scalar, list[Scalar], Range, AllOf, NoneOf, DatedFact]


class Filters(RootModel[dict[str, Condition]]):
    """Keys must come from GET /v1/commons/fields; the server rejects unknown keys with unknown_field.

    `has` is reserved: list of fields that must exist (e.g. ["open_jobs", "logo"]).
    """

    root: dict[str, Condition] = Field(default_factory=dict)

    @field_validator("root")
    @classmethod
    def _keys(cls, v: dict[str, Condition]) -> dict[str, Condition]:
        for k in v:
            if not re.match(r"^[a-z][a-z0-9_]{0,63}$", k):
                raise ValueError(f"bad filter key: {k!r}")
        if "has" in v and not isinstance(v["has"], list):
            raise ValueError("has takes a list of field names")
        return v


class Exclude(Strict):
    filters: Filters | None = None
    ids: list[str] = Field(default_factory=list, max_length=10_000)
    in_private_layer: bool = Field(False, description="Skip companies already in the caller's Papr memory.")


Entity = Literal["company"]  # "person" arrives in Phase 2, if legal clears
