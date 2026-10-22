"""Scout Commons HTTP API (Cloud Run service).

    GET /commons/v1/health
    GET /commons/v1/release
    GET /commons/v1/neighbors?domain=lemlist.com&k=50

/neighbors returns
    200 {"status": "ready", ...}         lookalikes computed for this release
    202 {"status": "queued", ...}        first request for this seed; the worker
                                         computes it (retry after `retry_after` s)
    200 {"status": "not_in_graph", ...}  Common Crawl has no links to this domain
    400 invalid domain, 401 bad key, 503 no release built yet

Only public link data is served. Requests are not logged with any caller
identity, and the response for a domain is identical for every caller.

Env:
    COMMONS_DATA_DIR   root of the store (default ./data)
    COMMONS_API_KEYS   optional comma list; when set, X-API-Key must match one
    COMMONS_INLINE     "1" computes misses in the request (dev / small graphs)
"""

from __future__ import annotations

import hmac
import os

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

from .compute import compute_one
from .graph import normalize_domain
from .store import Store

MAX_K = 500
RETRY_AFTER_S = 120


def _store() -> Store:
    return Store(os.environ.get("COMMONS_DATA_DIR", "./data"))


def _check_key(x_api_key: str | None = Header(default=None)) -> None:
    keys = [k.strip() for k in os.environ.get("COMMONS_API_KEYS", "").split(",") if k.strip()]
    if not keys:
        return
    if not x_api_key or not any(hmac.compare_digest(x_api_key, k) for k in keys):
        raise HTTPException(status_code=401, detail="X-API-Key required")


app = FastAPI(title="Scout Commons", version="1", docs_url=None, redoc_url=None)


@app.get("/commons/v1/health")
def health() -> dict:
    return {"ok": True, "service": "scout-commons", "release": _store().current_release()}


@app.get("/commons/v1/release", dependencies=[Depends(_check_key)])
def release() -> dict:
    store = _store()
    rel = store.current_release()
    if not rel:
        raise HTTPException(status_code=503, detail="No release built yet")
    return {"release": rel, **store.release_meta(rel)}


@app.get("/commons/v1/neighbors", dependencies=[Depends(_check_key)])
def neighbors(domain: str = Query(..., max_length=300), k: int = Query(50, ge=1, le=MAX_K)):
    d = normalize_domain(domain)
    if not d:
        raise HTTPException(status_code=400, detail="Not a domain")
    store = _store()
    rel = store.current_release()
    if not rel:
        raise HTTPException(status_code=503, detail="No release built yet")

    hit = store.get_neighbors(rel, d)
    if hit is None and os.environ.get("COMMONS_INLINE") == "1":
        hit = compute_one(store, rel, d)
    if hit is None:
        store.enqueue(d)
        return JSONResponse(
            status_code=202,
            headers={"Retry-After": str(RETRY_AFTER_S)},
            content={"status": "queued", "domain": d, "release": rel, "retry_after": RETRY_AFTER_S},
        )
    return {**hit, "neighbors": hit.get("neighbors", [])[:k], "k": k}
