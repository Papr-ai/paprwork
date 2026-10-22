"""Compute lookalikes for queued seeds (Cloud Run job: `python -m commons.compute`).

Each seed is computed once per release at k=500 and written to the store, so
later requests are a file read. The worker also refreshes a release's most
requested seeds when a new release goes live (see `requeue_previous`).
"""

from __future__ import annotations

import argparse
import os
import sys
import time

from .graph import Graph, candidates
from .store import Store

STORE_K = 500


def compute_one(store: Store, release: str, domain: str, graph: Graph | None = None) -> dict:
    g = graph or Graph(store.release_dir(release), threads=int(os.environ.get("COMMONS_THREADS", "4")))
    hit = g.resolve(domain)
    if hit is None:
        payload = {"status": "not_in_graph", "domain": domain, "release": release, "neighbors": []}
    else:
        seed_id, matched = hit
        res = g.neighbors(seed_id, matched, k=STORE_K)
        # Never return the seed itself or its own sub/parent domains.
        own = set(candidates(domain)) | {matched}
        payload = {
            "status": "ready",
            "domain": domain,
            "matched_domain": matched,
            "release": release,
            "citers": res.citers,
            "neighbors": [
                {"domain": n.domain, "score": n.score, "shared_citers": n.shared_citers}
                for n in res.neighbors
                if n.domain not in own and not n.domain.endswith("." + matched)
            ],
        }
    store.put_neighbors(release, domain, payload)
    return payload


def requeue_previous(store: Store, old: str) -> int:
    """Queue every seed computed for `old` so the new release has them too."""
    d = store.root / "neighbors" / old
    if not d.exists():
        return 0
    n = 0
    for p in d.glob("*.json"):
        store.enqueue(p.stem)
        n += 1
    return n


def drain(store: Store, budget_s: float, limit: int) -> int:
    rel = store.current_release()
    if not rel:
        print("no release yet; nothing to do")
        return 0
    graph = Graph(store.release_dir(rel), threads=int(os.environ.get("COMMONS_THREADS", "4")))
    start, done = time.monotonic(), 0
    for domain in store.queued(limit):
        if time.monotonic() - start > budget_s:
            break
        if store.get_neighbors(rel, domain) is None:
            t = time.monotonic()
            out = compute_one(store, rel, domain, graph)
            print(f"{domain}: {out['status']} {len(out['neighbors'])} in {time.monotonic() - t:.1f}s", flush=True)
        store.dequeue(domain)
        done += 1
    return done


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Compute queued Scout Commons lookalikes")
    ap.add_argument("--data-dir", default=os.environ.get("COMMONS_DATA_DIR", "./data"))
    ap.add_argument("--budget-s", type=float, default=50 * 60, help="stop picking new seeds after this")
    ap.add_argument("--limit", type=int, default=1000)
    args = ap.parse_args(argv)
    n = drain(Store(args.data_dir), args.budget_s, args.limit)
    print(f"computed {n} seed(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
