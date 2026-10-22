"""File layout under COMMONS_DATA_DIR (a GCS bucket mounted on Cloud Run).

    current                          name of the live link-graph release
    releases/<release>/              parquet graph from build.py (+ meta.json)
    neighbors/<release>/<d>.json     computed lookalikes for one seed domain
    patterns/<d>.json                email pattern for a domain (no addresses)
    ats/<d>.json                     job boards found for a domain
    ats/index/current.json           which Common Crawl slug index is live
    ats/index/<crawl>/<vendor>.json  every board slug seen for one ATS vendor
    recipes/<status>/<id>.json       dataset definitions: pending, validated,
                                     approved or rejected
    optout/<d>                       empty file: never compute or serve a pattern
    queue/<kind>/<d>                 empty file: work waiting for the worker

Plain files keep the service stateless and let the API (Cloud Run service)
and the worker (Cloud Run job) share data without a database.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


class Store:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    # -- generic -----------------------------------------------------------
    def read(self, rel: str) -> dict | None:
        p = self.root / rel
        return json.loads(p.read_text()) if p.is_file() else None

    def write(self, rel: str, obj: dict) -> None:
        self._write(self.root / rel, json.dumps(obj, separators=(",", ":")))

    def delete(self, rel: str) -> None:
        (self.root / rel).unlink(missing_ok=True)

    def exists(self, rel: str) -> bool:
        return (self.root / rel).exists()

    def touch(self, rel: str) -> None:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch(exist_ok=True)

    def ls(self, rel_dir: str) -> list[str]:
        """Stems of the *.json files in a directory, sorted."""
        d = self.root / rel_dir
        return sorted(p.stem for p in d.glob("*.json")) if d.is_dir() else []

    # -- releases ----------------------------------------------------------
    def current_release(self) -> str | None:
        p = self.root / "current"
        if not p.exists():
            return None
        name = p.read_text().strip()
        return name or None

    def set_current(self, release: str) -> None:
        self._write(self.root / "current", release + "\n")

    def release_dir(self, release: str) -> Path:
        return self.root / "releases" / release

    def release_meta(self, release: str) -> dict:
        return self.read(f"releases/{release}/meta.json") or {}

    # -- computed neighbours ----------------------------------------------
    def get_neighbors(self, release: str, domain: str) -> dict | None:
        return self.read(f"neighbors/{release}/{domain}.json")

    def put_neighbors(self, release: str, domain: str, payload: dict) -> None:
        self.write(f"neighbors/{release}/{domain}.json", payload)

    # -- queues ------------------------------------------------------------
    def enqueue(self, domain: str, kind: str = "neighbors") -> None:
        self.touch(f"queue/{kind}/{domain}")

    def queued(self, kind: str = "neighbors", limit: int = 1000) -> list[str]:
        q = self.root / "queue" / kind
        if not q.is_dir():
            return []
        return sorted(p.name for p in q.iterdir() if p.is_file() and not p.name.startswith("."))[:limit]

    def dequeue(self, domain: str, kind: str = "neighbors") -> None:
        (self.root / "queue" / kind / domain).unlink(missing_ok=True)

    def is_queued(self, domain: str, kind: str = "neighbors") -> bool:
        return (self.root / "queue" / kind / domain).exists()

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _write(path: Path, text: str) -> None:
        """Write via a temp file + rename so readers never see half a file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        os.replace(tmp, path)
