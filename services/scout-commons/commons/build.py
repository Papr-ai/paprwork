"""Build a Scout Commons release from the Common Crawl domain-level web graph.

    python -m commons.build --data-dir /mnt/commons --work-dir /scratch [--release cc-main-...]

Steps: pick the newest graph from graphinfo.json, download the domain
vertices + edges (resumable), convert to parquet with DuckDB, write
vertices / deg / rev / fwd into releases/<release>/, then switch `current`
and queue every seed that was computed for the previous release.

Needs roughly 16 GB RAM and 60 GB scratch disk; edges are ~2 billion rows.
Run it on a VM or Cloud Batch, not a Cloud Run service. Raw downloads are
deleted at the end; the release itself is ~9 GB.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import urllib.request
from pathlib import Path

import duckdb

from .compute import requeue_previous
from .store import Store

GRAPHINFO = "https://index.commoncrawl.org/graphinfo.json"
BASE = "https://data.commoncrawl.org/projects/hyperlinkgraph/{r}/domain/{r}-domain-{part}.txt.gz"
HUB_CAP = 2000
CHUNK = 8 << 20


def latest_release() -> str:
    with urllib.request.urlopen(GRAPHINFO, timeout=60) as r:
        return json.load(r)[0]["id"]


def download(url: str, dest: Path) -> Path:
    """Stream to dest, resuming a partial file with a Range request."""
    part = dest.with_suffix(dest.suffix + ".part")
    if dest.exists():
        return dest
    have = part.stat().st_size if part.exists() else 0
    req = urllib.request.Request(url, headers={"Range": f"bytes={have}-"} if have else {})
    with urllib.request.urlopen(req, timeout=120) as r, open(part, "ab" if have else "wb") as fh:
        if have and r.status != 206:
            fh.truncate(0)
        while chunk := r.read(CHUNK):
            fh.write(chunk)
    part.rename(dest)
    return dest


def convert(raw_v: Path, raw_e: Path, out: Path, work: Path, hub_cap: int) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(work / "build.duckdb"))
    con.execute(f"SET threads={os.cpu_count() or 4}")
    con.execute(f"SET memory_limit='{os.environ.get('COMMONS_BUILD_MEM', '14GB')}'")
    con.execute(f"SET temp_directory='{work / 'tmp'}'")

    def q(p: Path) -> str:
        return str(p).replace("'", "''")

    t = time.monotonic()
    # Vertices are "id <TAB> reversed.domain <TAB> host count"; store the domain forwards.
    con.execute(f"""COPY (SELECT id, array_to_string(list_reverse(string_split(rdom, '.')), '.') AS domain
        FROM read_csv('{q(raw_v)}', delim='\t', header=false, quote='', escape='',
                      columns={{'id':'UINTEGER','rdom':'VARCHAR','nh':'UINTEGER'}}))
        TO '{q(out / "vertices.parquet")}' (FORMAT parquet, COMPRESSION zstd)""")
    con.execute(f"""CREATE TABLE e AS SELECT * FROM read_csv('{q(raw_e)}', delim='\t', header=false,
        quote='', escape='', columns={{'f':'UINTEGER','t':'UINTEGER'}})""")
    con.execute(f"""COPY (SELECT v.id, coalesce(i.ind, 0)::UINTEGER AS ind, coalesce(o.od, 0)::UINTEGER AS od
        FROM '{q(out / "vertices.parquet")}' v
        LEFT JOIN (SELECT t AS id, count(*) AS ind FROM e GROUP BY t) i USING (id)
        LEFT JOIN (SELECT f AS id, count(*) AS od FROM e GROUP BY f) o USING (id))
        TO '{q(out / "deg.parquet")}' (FORMAT parquet, COMPRESSION zstd)""")
    keep = f"(SELECT id FROM '{q(out / 'deg.parquet')}' WHERE od <= {int(hub_cap)})"
    for name, cols, order in (("rev", "e.t, e.f", "e.t"), ("fwd", "e.f, e.t", "e.f")):
        con.execute(f"""COPY (SELECT {cols} FROM e JOIN {keep} k ON k.id = e.f ORDER BY {order})
            TO '{q(out / f"{name}.parquet")}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 500000)""")
    n_dom, n_edge = con.execute(
        f"SELECT (SELECT count(*) FROM '{q(out / 'vertices.parquet')}'), (SELECT count(*) FROM e)"
    ).fetchone()
    stats = {"domains": n_dom, "edges": n_edge}
    con.close()
    (work / "build.duckdb").unlink(missing_ok=True)
    return {**stats, "hub_cap": hub_cap, "build_seconds": round(time.monotonic() - t)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build a Scout Commons link-graph release")
    ap.add_argument("--data-dir", default=os.environ.get("COMMONS_DATA_DIR", "./data"))
    ap.add_argument("--work-dir", default=os.environ.get("COMMONS_WORK_DIR", "./work"))
    ap.add_argument("--release", help="Common Crawl graph id (default: newest)")
    ap.add_argument("--hub-cap", type=int, default=HUB_CAP)
    ap.add_argument("--keep-raw", action="store_true")
    args = ap.parse_args(argv)

    store, work = Store(args.data_dir), Path(args.work_dir)
    (work / "tmp").mkdir(parents=True, exist_ok=True)
    rel = args.release or latest_release()
    if store.current_release() == rel:
        print(f"{rel} is already live")
        return 0
    raw = {p: download(BASE.format(r=rel, part=p), work / f"{rel}-{p}.txt.gz") for p in ("vertices", "edges")}
    staging = work / "release" / rel
    meta = convert(raw["vertices"], raw["edges"], staging, work, args.hub_cap)
    meta.update(source=BASE.format(r=rel, part="{vertices,edges}"), built_at=int(time.time()))
    (staging / "meta.json").write_text(json.dumps(meta, indent=1))

    dest = store.release_dir(rel)
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(staging, dest)
    old = store.current_release()
    store.set_current(rel)
    n = requeue_previous(store, old) if old else 0
    print(f"{rel} live: {meta['domains']} domains, {meta['edges']} edges; requeued {n} seed(s)")
    if not args.keep_raw:
        for p in raw.values():
            p.unlink(missing_ok=True)
        shutil.rmtree(staging, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
