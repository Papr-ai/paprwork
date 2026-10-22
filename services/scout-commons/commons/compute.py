"""Scout Commons worker (Cloud Run job: `python -m commons.compute`, every 5 minutes).

Works through four queues:
- `neighbors`: link-graph lookalikes, computed once per release at k=500
- `patterns`: email patterns
- `ats`: job boards
- `recipes`: checks for submitted and due dataset definitions

Other modes:
    --seed-recipes     submit the built-in dataset definitions
    --ats-index        rebuild the Common Crawl job-board index (monthly)
    --optout DOMAIN    stop computing or serving an email pattern for DOMAIN
"""

from __future__ import annotations

import argparse
import os
import sys
import time

from .ats import build_index, compute_ats
from .graph import Graph, candidates
from .patterns import compute_pattern
from .recipes import load_seeds, requeue_due, validate
from .store import Store

STORE_K = 500
KINDS = ("neighbors", "patterns", "ats", "recipes")


def _threads() -> int:
    return int(os.environ.get("COMMONS_THREADS", "4"))


def compute_one(store: Store, release: str, domain: str, graph: Graph | None = None) -> dict:
    g = graph or Graph(store.release_dir(release), threads=_threads())
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


def opted_out(store: Store, domain: str) -> bool:
    return any(store.exists(f"optout/{d}") for d in candidates(domain))


def pattern_for(store: Store, domain: str) -> dict:
    if opted_out(store, domain):
        store.delete(f"patterns/{domain}.json")
        return {"status": "opted_out", "domain": domain}
    return compute_pattern(store, domain)


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


def drain(store: Store, budget_s: float, limit: int, kinds: tuple[str, ...] = KINDS) -> int:
    start, done = time.monotonic(), 0
    rel = store.current_release()
    graph = None
    if "recipes" in kinds:
        requeue_due(store)
    for kind in kinds:
        if kind == "neighbors" and not rel:
            continue
        for key in store.queued(kind, limit):
            if time.monotonic() - start > budget_s or done >= limit:
                return done
            t = time.monotonic()
            try:
                if kind == "neighbors":
                    if store.get_neighbors(rel, key) is None:
                        graph = graph or Graph(store.release_dir(rel), threads=_threads())
                        out = compute_one(store, rel, key, graph)
                    else:
                        out = {"status": "cached"}
                elif kind == "patterns":
                    out = pattern_for(store, key)
                elif kind == "ats":
                    out = compute_ats(store, key)
                else:
                    out = validate(store, key) or {"status": "missing"}
            except Exception as e:  # noqa: BLE001 - one bad item must not stop the queue
                print(f"{kind} {key}: error {type(e).__name__}: {e}", flush=True)
                out = {"status": "error"}
            print(f"{kind} {key}: {out.get('status')} in {time.monotonic() - t:.1f}s", flush=True)
            store.dequeue(key, kind)
            done += 1
    return done


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Scout Commons worker")
    ap.add_argument("--data-dir", default=os.environ.get("COMMONS_DATA_DIR", "./data"))
    ap.add_argument("--budget-s", type=float, default=50 * 60, help="stop picking new items after this")
    ap.add_argument("--limit", type=int, default=1000)
    ap.add_argument("--kinds", default=",".join(KINDS))
    ap.add_argument("--seed-recipes", action="store_true")
    ap.add_argument("--ats-index", action="store_true")
    ap.add_argument("--crawl", help="Common Crawl id for --ats-index (default: newest)")
    ap.add_argument("--optout", metavar="DOMAIN")
    args = ap.parse_args(argv)
    store = Store(args.data_dir)
    if args.optout:
        store.touch(f"optout/{args.optout.lower()}")
        store.delete(f"patterns/{args.optout.lower()}.json")
        print(f"opted out {args.optout}")
        return 0
    if args.seed_recipes:
        print(f"submitted {load_seeds(store)} seed recipe(s)")
    if args.ats_index:
        print(build_index(store, args.crawl))
        return 0
    n = drain(store, args.budget_s, args.limit, tuple(k for k in args.kinds.split(",") if k in KINDS))
    print(f"processed {n} item(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
