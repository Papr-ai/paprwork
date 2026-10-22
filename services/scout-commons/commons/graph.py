"""Link-graph lookalikes ("co-citation") over the Common Crawl domain graph.

Two domains are lookalikes when the same sites link to both of them. For a
seed s and a candidate t, over every citer c that links to both:

    w(s, t)  = sum of 1 / ln(1 + outdeg(c))
    score_D  = w(s, t) / sqrt(indeg(t))

Citers with more than ``hub_cap`` outlinks (directories, link farms) were
dropped at build time. A candidate needs at least ``min_shared`` shared citers.
Scores are divided by the best score for the seed, so they run 0..1.

The graph lives in one release directory of parquet files written by
``build.py``: ``vertices`` (id, domain), ``deg`` (id, ind, od), ``rev`` (t, f)
sorted by t, and ``fwd`` (f, t) sorted by f.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import duckdb

_DOMAIN = re.compile(r"^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")


def normalize_domain(raw: str) -> str | None:
    """'https://WWW.Lemlist.com/pricing' -> 'lemlist.com'. None if not a domain."""
    d = (raw or "").strip().lower()
    d = re.sub(r"^[a-z][a-z0-9+.-]*://", "", d)
    d = d.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    d = d.rsplit("@", 1)[-1].split(":", 1)[0].rstrip(".")
    d = d.removeprefix("www.")
    return d if _DOMAIN.match(d) else None


def candidates(domain: str) -> list[str]:
    """The domain, then each parent with at least two labels: a.b.c.com -> b.c.com -> c.com."""
    parts = domain.split(".")
    return [".".join(parts[i:]) for i in range(len(parts) - 1)]


@dataclass(frozen=True)
class Neighbor:
    domain: str
    score: float
    shared_citers: int


@dataclass(frozen=True)
class Result:
    domain: str
    citers: int
    neighbors: list[Neighbor]


class Graph:
    """Read-only queries against one release directory."""

    def __init__(self, release_dir: str | Path, threads: int = 4) -> None:
        self.dir = Path(release_dir)
        self.threads = threads
        for name in ("vertices", "deg", "rev", "fwd"):
            if not (self.dir / f"{name}.parquet").exists():
                raise FileNotFoundError(f"{self.dir}/{name}.parquet missing")

    def _con(self) -> duckdb.DuckDBPyConnection:
        con = duckdb.connect(":memory:")
        con.execute(f"SET threads={int(self.threads)}")
        return con

    def _p(self, name: str) -> str:
        return str(self.dir / f"{name}.parquet").replace("'", "''")

    def resolve(self, domain: str) -> tuple[int, str] | None:
        """Graph id for the domain or its closest parent that is in the graph."""
        names = candidates(domain)
        con = self._con()
        try:
            rows = con.execute(
                f"SELECT domain, id FROM '{self._p('vertices')}' WHERE domain IN (SELECT unnest(?))",
                [names],
            ).fetchall()
        finally:
            con.close()
        found = {d: i for d, i in rows}
        for name in names:
            if name in found:
                return int(found[name]), name
        return None

    def neighbors(self, seed_id: int, seed_domain: str, k: int = 500, min_shared: int = 3) -> Result:
        con = self._con()
        try:
            con.execute(
                f"""CREATE TEMP TABLE c AS
                    SELECT r.f, d.od FROM '{self._p("rev")}' r JOIN '{self._p("deg")}' d ON d.id = r.f
                    WHERE r.t = ?""",
                [seed_id],
            )
            n_citers = con.execute("SELECT count(*) FROM c").fetchone()[0]
            rows = con.execute(
                f"""WITH co AS (
                      SELECT e.t, count(*) AS n, sum(1.0 / ln(1 + c.od)) AS w
                      FROM '{self._p("fwd")}' e JOIN c ON c.f = e.f
                      WHERE e.t <> ? GROUP BY e.t HAVING count(*) >= ?),
                    s AS (
                      SELECT co.t, co.n, co.w / sqrt(d.ind) AS sc
                      FROM co JOIN '{self._p("deg")}' d ON d.id = co.t
                      ORDER BY sc DESC, co.t LIMIT ?)
                    SELECT v.domain, s.sc, s.n FROM s JOIN '{self._p("vertices")}' v ON v.id = s.t
                    ORDER BY s.sc DESC, v.domain""",
                [seed_id, min_shared, k],
            ).fetchall()
        finally:
            con.close()
        top = rows[0][1] if rows else 1.0
        out = [Neighbor(d, round(sc / top, 6), int(n)) for d, sc, n in rows]
        return Result(seed_domain, int(n_citers), out)
