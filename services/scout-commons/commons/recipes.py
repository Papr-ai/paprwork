"""Shared open-data dataset definitions ("recipes").

A recipe tells Scout how to read sales signals from a public dataset: which
city portal and dataset, which column holds the event date, which columns hold
the business name and address, and which rows count (for example only new
licences, not renewals).

Any Scout install can submit a recipe. It is shared with everyone once the
worker has checked it automatically. Nothing about the submitter is stored.

**Checks (all must pass):**
- The dataset exists, and every named column is in it.
- The date column is a date type, and its name doesn't look like an expiry,
  renewal or due date.
- Filters only use literal values.
- At least 5 matching rows in the last 90 days, and the newest is no more than
  14 days old.

Structural failures are `rejected`. Freshness failures are `stale`. Shared
recipes are rechecked weekly, so a dataset that stops updating drops out on
its own.

v1 supports Socrata portals (data.cityofchicago.org, data.ny.gov, …).
ArcGIS and CKAN are left for later.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .graph import normalize_domain
from .http import client, get_json
from .store import Store

COL = r"^[a-z_][a-z0-9_]{0,62}$"
_COL = re.compile(COL)
EXPIRY = re.compile(r"expir|renew|due|lapse|cancel|end_?date|valid_?(?:to|until|thru)|_end$", re.I)
DATE_TYPES = frozenset({"calendar_date", "date", "floating_timestamp", "fixed_timestamp"})
FRESH_DAYS, MIN_ROWS_90D, RECHECK_S = 14, 5, 7 * 86400
SEEDS = Path(__file__).with_name("seed_recipes.json")


class Recipe(BaseModel):
    model_config = ConfigDict(extra="forbid")

    platform: Literal["socrata"] = "socrata"
    domain: str = Field(max_length=200)
    dataset_id: str = Field(pattern=r"^[a-z0-9]{4}-[a-z0-9]{4}$")
    title: str = Field(min_length=3, max_length=200)
    geo_state: str = Field(pattern=r"^[A-Z]{2}$")
    geo_city: str | None = Field(default=None, max_length=80)
    signal_type: str = Field(pattern=r"^[a-z][a-z0-9_]{2,40}$")
    polarity: Literal["positive", "negative"] = "positive"
    date_col: str = Field(pattern=COL)
    date_kind: Literal["filed", "inspected", "issued"]
    name_col: str | None = Field(default=None, pattern=COL)
    addr_col: str | None = Field(default=None, pattern=COL)
    phone_col: str | None = Field(default=None, pattern=COL)
    pk_col: str | None = Field(default=None, pattern=COL)
    event_filter: dict[str, list[str]] = Field(default_factory=dict)
    reason_template: str = Field(min_length=6, max_length=300)
    terms_url: str | None = Field(default=None, max_length=300)
    created_by: Literal["seed", "auto"] = "auto"

    @field_validator("domain")
    @classmethod
    def _domain(cls, v: str) -> str:
        d = normalize_domain(v)
        if not d:
            raise ValueError("not a domain")
        return d

    @field_validator("event_filter")
    @classmethod
    def _filter(cls, v: dict[str, list[str]]) -> dict[str, list[str]]:
        if len(v) > 5:
            raise ValueError("at most 5 filter columns")
        for col, vals in v.items():
            if not _COL.match(col) or not 1 <= len(vals) <= 20 or any(len(x) > 100 for x in vals):
                raise ValueError(f"bad filter on {col!r}")
        return v

    @field_validator("reason_template")
    @classmethod
    def _reason(cls, v: str) -> str:
        if "{date}" not in v:
            raise ValueError("reason_template must contain {date}")
        return v


def recipe_id(r: Recipe) -> str:
    """Same definition -> same id, whoever submits it (provenance is not part of the key)."""
    key = json.dumps(r.model_dump(exclude={"created_by"}), sort_keys=True)
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def _path(rid: str) -> str:
    return f"recipes/{rid}.json"


def submit(store: Store, r: Recipe) -> dict:
    rid = recipe_id(r)
    have = store.read(_path(rid))
    if have and have.get("status") in ("pending", "validated"):
        return have
    doc = {**r.model_dump(), "id": rid, "status": "pending", "submitted_at": int(time.time())}
    store.write(_path(rid), doc)
    store.enqueue(rid, "recipes")
    return doc


def _q(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


def soql_where(r: Recipe, now: datetime) -> str:
    lo = (now - timedelta(days=90)).strftime("%Y-%m-%dT%H:%M:%S")
    hi = now.strftime("%Y-%m-%dT%H:%M:%S")
    parts = [f"{r.date_col} > '{lo}'", f"{r.date_col} <= '{hi}'"]
    parts += [f"{col} IN ({', '.join(_q(x) for x in vals)})" for col, vals in sorted(r.event_filter.items())]
    return " AND ".join(parts)


def validate(store: Store, rid: str, now: datetime | None = None) -> dict | None:
    doc = store.read(_path(rid))
    if not doc:
        return None
    r = Recipe(**{k: doc[k] for k in Recipe.model_fields if k in doc})
    now = now or datetime.now(UTC).replace(tzinfo=None)
    broken: list[str] = []
    stale: list[str] = []
    rows_90d, newest = None, None
    with client() as c:
        meta = get_json(c, f"https://{r.domain}/api/views/{r.dataset_id}.json")
        if not isinstance(meta, dict) or not isinstance(meta.get("columns"), list):
            broken.append("dataset not found")
        else:
            cols = {x.get("fieldName"): x.get("dataTypeName") for x in meta["columns"]}
            named = [r.date_col, r.name_col, r.addr_col, r.phone_col, r.pk_col, *r.event_filter]
            broken += [f"column {n} not in dataset" for n in named if n and n not in cols]
            if r.date_col in cols and cols[r.date_col] not in DATE_TYPES:
                broken.append(f"{r.date_col} is {cols[r.date_col]}, not a date")
            if EXPIRY.search(r.date_col):
                broken.append(f"{r.date_col} looks like an expiry or renewal date")
        if not broken:
            rows = get_json(
                c,
                f"https://{r.domain}/resource/{r.dataset_id}.json",
                params={"$select": f"max({r.date_col}) AS newest, count(*) AS n", "$where": soql_where(r, now)},
            )
            if not isinstance(rows, list) or not rows:
                broken.append("query failed")
            else:
                rows_90d = int(rows[0].get("n") or 0)
                newest = (rows[0].get("newest") or "")[:10] or None
                if rows_90d < MIN_ROWS_90D:
                    stale.append(f"{rows_90d} matching rows in 90 days (need {MIN_ROWS_90D})")
                if not newest or datetime.fromisoformat(newest) < now - timedelta(days=FRESH_DAYS):
                    stale.append(f"newest row {newest or 'none'} is older than {FRESH_DAYS} days")
    doc.update(
        status="rejected" if broken else "stale" if stale else "validated",
        reasons=broken + stale,
        rows_90d=rows_90d,
        newest=newest,
        checked_at=int(time.time()),
    )
    store.write(_path(rid), doc)
    return doc


def requeue_due(store: Store) -> int:
    """Queue shared and stale recipes that haven't been checked for a week."""
    n = 0
    for rid in store.ls("recipes"):
        doc = store.read(_path(rid)) or {}
        if doc.get("status") in ("validated", "stale") and time.time() - doc.get("checked_at", 0) > RECHECK_S:
            store.enqueue(rid, "recipes")
            n += 1
    return n


def list_recipes(store: Store, state: str | None, city: str | None, signal_type: str | None) -> list[dict]:
    out = []
    for rid in store.ls("recipes"):
        d = store.read(_path(rid)) or {}
        if d.get("status") != "validated":
            continue
        if state and d.get("geo_state") != state.upper():
            continue
        if city and (d.get("geo_city") or "").lower() != city.lower():
            continue
        if signal_type and d.get("signal_type") != signal_type:
            continue
        out.append(d)
    return sorted(out, key=lambda d: (d["geo_state"], d.get("geo_city") or "", d["title"]))


def load_seeds(store: Store) -> int:
    return sum(1 for item in json.loads(SEEDS.read_text()) if submit(store, Recipe(**item, created_by="seed")))
