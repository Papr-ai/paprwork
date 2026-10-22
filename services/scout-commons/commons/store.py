"""File layout under COMMONS_DATA_DIR (a GCS bucket mounted on Cloud Run).

    current                      text file: name of the live release
    releases/<release>/          parquet graph from build.py (+ meta.json)
    neighbors/<release>/<d>.json computed lookalikes for one seed domain
    queue/<d>                    empty file: seed waiting for the worker

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
        p = self.release_dir(release) / "meta.json"
        return json.loads(p.read_text()) if p.exists() else {}

    # -- computed neighbours ----------------------------------------------
    def _nb_path(self, release: str, domain: str) -> Path:
        return self.root / "neighbors" / release / f"{domain}.json"

    def get_neighbors(self, release: str, domain: str) -> dict | None:
        p = self._nb_path(release, domain)
        return json.loads(p.read_text()) if p.exists() else None

    def put_neighbors(self, release: str, domain: str, payload: dict) -> None:
        self._write(self._nb_path(release, domain), json.dumps(payload, separators=(",", ":")))

    # -- queue -------------------------------------------------------------
    def enqueue(self, domain: str) -> None:
        q = self.root / "queue"
        q.mkdir(parents=True, exist_ok=True)
        (q / domain).touch(exist_ok=True)

    def queued(self, limit: int = 1000) -> list[str]:
        q = self.root / "queue"
        if not q.exists():
            return []
        return sorted(p.name for p in q.iterdir() if p.is_file())[:limit]

    def dequeue(self, domain: str) -> None:
        (self.root / "queue" / domain).unlink(missing_ok=True)

    def is_queued(self, domain: str) -> bool:
        return (self.root / "queue" / domain).exists()

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _write(path: Path, text: str) -> None:
        """Write via a temp file + rename so readers never see half a file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        os.replace(tmp, path)
