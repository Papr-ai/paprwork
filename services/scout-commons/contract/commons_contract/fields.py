"""GET /v1/commons/fields: filter-key discovery. The server's filter validation reads this same list."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class FieldInfo(BaseModel):
    name: str
    type: Literal["keyword", "number", "date", "bool", "dated_vendor", "role"]
    operators: list[Literal["eq", "any", "all", "not", "range", "since", "has"]]
    values: list[str] | None = Field(None, description="Allowed values when the field is an enum.")
    facetable: bool = False
    sortable: bool = False
    in_vector_store: bool = Field(False, description="Copied into Qdrant payload; cheap with /search.")


class FieldsData(BaseModel):
    entity: Literal["company"]
    release: str
    fields: list[FieldInfo]
