"""Scout Commons HTTP API (Cloud Run service).

    GET  /commons/v1/health
    GET  /commons/v1/release
    GET  /commons/v1/neighbors?domain=lemlist.com&k=50   link-graph lookalikes
    GET  /commons/v1/pattern?domain=close.com            email pattern (no addresses)
    GET  /commons/v1/ats?domain=lemlist.com              job boards a company uses
    GET  /commons/v1/ats/boards?vendor=greenhouse        board index from Common Crawl
    GET  /commons/v1/recipes?state=IL&city=Chicago       shared dataset definitions
    GET  /commons/v1/recipes/{id}                        one definition, any status
    POST /commons/v1/recipes                             submit a definition

Per-domain lookups answer straight from the store. When nothing has been
computed yet they return `202 queued`, and the worker fills it in within a few
minutes. A result past its refresh age is still returned, with `stale: true`,
and is re-queued.

Only public data is served. Requests are not logged with any caller identity,
and every caller gets the same answer.

Env:
    COMMONS_DATA_DIR   root of the store (default ./data)
    COMMONS_API_KEYS   optional comma list; when set, X-API-Key must match one
    COMMONS_INLINE     "1" computes misses in the request (dev / small graphs)
"""

from __future__ import annotations

import hmac
import os
import time
from collections.abc import Callable

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

from . import ats, recipes
from .compute import compute_one, opted_out, pattern_for
from .graph import normalize_domain
from .patterns import TTL_S as PATTERN_TTL
from .store import Store

MAX_K = 500
RETRY_AFTER_S = 120


def _store() -> Store:
    return Store(os.environ.get("COMMONS_DATA_DIR", "./data"))


def _inline() -> bool:
    return os.environ.get("COMMONS_INLINE") == "1"


def _check_key(x_api_key: str | None = Header(default=None)) -> None:
    keys = [k.strip() for k in os.environ.get("COMMONS_API_KEYS", "").split(",") if k.strip()]
    if not keys:
        return
    if not x_api_key or not any(hmac.compare_digest(x_api_key, k) for k in keys):
        raise HTTPException(status_code=401, detail="X-API-Key required")


def _domain(raw: str) -> str:
    d = normalize_domain(raw)
    if not d:
        raise HTTPException(status_code=400, detail="Not a domain")
    return d


def _queued(d: str, **extra) -> JSONResponse:
    return JSONResponse(
        status_code=202,
        headers={"Retry-After": str(RETRY_AFTER_S)},
        content={"status": "queued", "domain": d, "retry_after": RETRY_AFTER_S, **extra},
    )


def _per_domain(store: Store, kind: str, d: str, ttl: int, compute: Callable[[Store, str], dict]):
    hit = store.read(f"{kind}/{d}.json")
    fresh = hit is not None and time.time() - hit.get("computed_at", 0) < ttl
    if not fresh and _inline():
        return compute(store, d)
    if hit is None:
        store.enqueue(d, kind)
        return _queued(d)
    if not fresh:
        store.enqueue(d, kind)
        return {**hit, "stale": True}
    return hit


app = FastAPI(title="Scout Commons", version="1", docs_url=None, redoc_url=None)
v1 = [Depends(_check_key)]


@app.get("/commons/v1/health")
def health() -> dict:
    return {"ok": True, "service": "scout-commons", "release": _store().current_release()}


@app.get("/commons/v1/release", dependencies=v1)
def release() -> dict:
    store = _store()
    rel = store.current_release()
    if not rel:
        raise HTTPException(status_code=503, detail="No release built yet")
    return {"release": rel, **store.release_meta(rel), "ats_index": store.read("ats/index/current.json")}


@app.get("/commons/v1/neighbors", dependencies=v1)
def neighbors(domain: str = Query(..., max_length=300), k: int = Query(50, ge=1, le=MAX_K)):
    d = _domain(domain)
    store = _store()
    rel = store.current_release()
    if not rel:
        raise HTTPException(status_code=503, detail="No release built yet")
    hit = store.get_neighbors(rel, d)
    if hit is None and _inline():
        hit = compute_one(store, rel, d)
    if hit is None:
        store.enqueue(d)
        return _queued(d, release=rel)
    return {**hit, "neighbors": hit.get("neighbors", [])[:k], "k": k}


@app.get("/commons/v1/pattern", dependencies=v1)
def pattern(domain: str = Query(..., max_length=300)):
    d = _domain(domain)
    store = _store()
    if opted_out(store, d):
        return {"status": "opted_out", "domain": d}
    return _per_domain(store, "patterns", d, PATTERN_TTL, pattern_for)


@app.get("/commons/v1/ats", dependencies=v1)
def ats_for_domain(domain: str = Query(..., max_length=300)):
    return _per_domain(_store(), "ats", _domain(domain), ats.TTL_S, ats.compute_ats)


@app.get("/commons/v1/ats/boards", dependencies=v1)
def ats_boards(
    vendor: str = Query(..., pattern="^(" + "|".join(ats.VENDORS) + ")$"),
    offset: int = Query(0, ge=0),
    limit: int = Query(1000, ge=1, le=5000),
):
    out = ats.index_boards(_store(), vendor, offset, limit)
    if out is None:
        raise HTTPException(status_code=503, detail="Board index not built yet")
    return out


@app.get("/commons/v1/recipes", dependencies=v1)
def list_recipes(
    state: str | None = Query(None, pattern="^[A-Za-z]{2}$"),
    city: str | None = Query(None, max_length=80),
    signal_type: str | None = Query(None, max_length=40),
):
    found = recipes.list_recipes(_store(), state, city, signal_type)
    return {"recipes": found, "count": len(found)}


@app.get("/commons/v1/recipes/{rid}", dependencies=v1)
def get_recipe(rid: str):
    doc = _store().read(f"recipes/{rid}.json") if rid.isalnum() and len(rid) == 16 else None
    if not doc:
        raise HTTPException(status_code=404, detail="No such recipe")
    return doc


@app.post("/commons/v1/recipes", dependencies=v1, status_code=202)
def submit_recipe(body: recipes.Recipe):
    store = _store()
    doc = recipes.submit(store, body)
    if doc["status"] == "pending" and _inline():
        doc = recipes.validate(store, doc["id"]) or doc
    return doc
