"""Tiny Common Crawl-shaped graph so every test runs in well under a second.

Seed lemlist.com. Citers blog1..blog4 link to lemlist and to the lookalikes;
hub.com links to everything (more outlinks than the test hub cap, so it is
dropped); popular.com is linked by everyone, so its score is damped by indeg.
"""

from __future__ import annotations

import gzip
from pathlib import Path

import pytest

from commons.build import convert
from commons.store import Store

DOMAINS = [
    "lemlist.com",
    "smartlead.ai",
    "instantly.ai",
    "woodpecker.co",
    "popular.com",
    "blog1.com",
    "blog2.com",
    "blog3.com",
    "blog4.com",
    "hub.com",
    "app.lemlist.com",
    "loner.org",
    "f1.com",
    "f2.com",
    "f3.com",
    "f4.com",
    "f5.com",
    "f6.com",
]
ID = {d: i for i, d in enumerate(DOMAINS)}
LINKS = {
    "blog1.com": ["lemlist.com", "smartlead.ai", "instantly.ai", "woodpecker.co", "popular.com"],
    "blog2.com": ["lemlist.com", "smartlead.ai", "instantly.ai", "woodpecker.co", "popular.com"],
    "blog3.com": ["lemlist.com", "smartlead.ai", "instantly.ai", "woodpecker.co", "popular.com", "app.lemlist.com"],
    "blog4.com": ["lemlist.com", "smartlead.ai", "popular.com", "app.lemlist.com"],
    "hub.com": [d for d in DOMAINS if d != "hub.com"],
    # popular.com is linked by many unrelated sites too
    **{f"f{i}.com": ["popular.com"] for i in range(1, 7)},
}
HUB_CAP = 6


def _rev(d: str) -> str:
    return ".".join(reversed(d.split(".")))


@pytest.fixture()
def release(tmp_path: Path) -> tuple[Store, str]:
    work = tmp_path / "work"
    (work / "tmp").mkdir(parents=True)
    rv, re_ = work / "v.txt.gz", work / "e.txt.gz"
    with gzip.open(rv, "wt") as fh:
        for d, i in ID.items():
            fh.write(f"{i}\t{_rev(d)}\t1\n")
    with gzip.open(re_, "wt") as fh:
        for src, dsts in LINKS.items():
            for dst in dsts:
                fh.write(f"{ID[src]}\t{ID[dst]}\n")
    store = Store(tmp_path / "data")
    rel = "cc-main-test"
    convert(rv, re_, store.release_dir(rel), work, HUB_CAP)
    store.set_current(rel)
    return store, rel
