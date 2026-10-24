"""Job boards (applicant tracking systems) for companies.

Two parts:

1. **Per domain** (`compute_ats`): which public job boards a company uses.
   - Read the company's own homepage and careers pages and collect links to
     known job-board vendors. These are marked `found_via: "site"`.
   - Also try the domain's name as a board slug on Greenhouse, Lever and Ashby
     (lemlist.com -> "lemlist"). Matches are marked `found_via: "guess"`,
     because another company could own that slug.
   - Every board is checked against the vendor's public job API, and the
     result records how many jobs are open and the newest posting date.

2. **Index** (`build_index`, monthly): every board slug Common Crawl has seen
   for each vendor. It reads the crawl's `cluster.idx` and fetches only the
   index blocks for each vendor's URL prefix with range requests. Scout uses
   this to find companies that are hiring for a role.
"""

from __future__ import annotations

import bisect
import gzip
import re
import time
from datetime import UTC, datetime

import httpx

from .http import client, get_json, get_text, same_site
from .store import Store

TTL_S = 7 * 86400
CAREERS = ("/", "/careers", "/careers/", "/jobs", "/company/careers", "/about/careers", "/join-us", "/work-with-us")
_SLUG = r"([A-Za-z0-9][A-Za-z0-9_.-]{0,80})"
_HOST = r"([a-z0-9][a-z0-9-]{0,62})"

# vendor: (link regex, JSON API or None, public board URL)
VENDORS: dict[str, tuple[str, str | None, str]] = {
    "greenhouse": (
        rf"(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io/(?:embed/job_board\?for=)?{_SLUG}",
        "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
        "https://job-boards.greenhouse.io/{slug}",
    ),
    "lever": (
        rf"jobs(?:\.eu)?\.lever\.co/{_SLUG}",
        "https://api.lever.co/v0/postings/{slug}?mode=json",
        "https://jobs.lever.co/{slug}",
    ),
    "ashby": (
        rf"jobs\.ashbyhq\.com/{_SLUG}",
        "https://api.ashbyhq.com/posting-api/job-board/{slug}",
        "https://jobs.ashbyhq.com/{slug}",
    ),
    "workable": (
        rf"apply\.workable\.com/{_SLUG}",
        "https://apply.workable.com/api/v1/widget/accounts/{slug}",
        "https://apply.workable.com/{slug}/",
    ),
    "smartrecruiters": (
        rf"(?:jobs|careers)\.smartrecruiters\.com/{_SLUG}",
        "https://api.smartrecruiters.com/v1/companies/{slug}/postings",
        "https://jobs.smartrecruiters.com/{slug}",
    ),
    "recruitee": (
        rf"{_HOST}\.recruitee\.com",
        "https://{slug}.recruitee.com/api/offers/",
        "https://{slug}.recruitee.com/",
    ),
    "personio": (rf"{_HOST}\.jobs\.personio\.(?:de|com)", None, "https://{slug}.jobs.personio.de/"),
    "teamtailor": (rf"{_HOST}\.teamtailor\.com", None, "https://{slug}.teamtailor.com/jobs"),
    "bamboohr": (
        rf"{_HOST}\.bamboohr\.com/(?:careers|jobs)",
        "https://{slug}.bamboohr.com/careers/list",
        "https://{slug}.bamboohr.com/careers",
    ),
}
GUESS_VENDORS = ("greenhouse", "lever", "ashby")
# Common Crawl SURT prefixes; "path" takes the first path segment, "host" the next host label.
INDEX_PREFIXES: dict[str, list[tuple[str, str]]] = {
    "greenhouse": [("io,greenhouse,boards)/", "path"), ("io,greenhouse,job-boards)/", "path")],
    "lever": [("co,lever,jobs)/", "path")],
    "ashby": [("com,ashbyhq,jobs)/", "path")],
    "workable": [("com,workable,apply)/", "path")],
    "smartrecruiters": [("com,smartrecruiters,jobs)/", "path"), ("com,smartrecruiters,careers)/", "path")],
    "recruitee": [("com,recruitee,", "host")],
    "personio": [("de,personio,jobs,", "host")],
    "teamtailor": [("com,teamtailor,", "host")],
    "bamboohr": [("com,bamboohr,", "host")],
}
NOT_SLUGS = frozenset(
    "embed jobs job api v0 v1 js css static assets robots.txt favicon.ico sitemap.xml careers en de fr es "
    "www app help support status blog login signup cdn marketing docs about privacy terms".split()
)
_RX = {v: re.compile(spec[0], re.I) for v, spec in VENDORS.items()}


def find_links(text: str) -> set[tuple[str, str]]:
    out = set()
    for vendor, rx in _RX.items():
        for m in rx.finditer(text):
            slug = m.group(1).rstrip(".").split("?", 1)[0]
            if slug.lower() not in NOT_SLUGS:
                out.add((vendor, slug.lower() if vendor not in ("smartrecruiters",) else slug))
    return out


def _iso(v) -> str | None:
    if v is None or v == "":
        return None
    if isinstance(v, int | float):
        return datetime.fromtimestamp(v / 1000, UTC).date().isoformat()
    return str(v)[:10]


def _jobs(vendor: str, data) -> tuple[int, str | None] | None:
    """(open jobs, newest posting date) from a vendor API response."""
    rows, key = {
        "greenhouse": (lambda d: d.get("jobs"), "first_published"),
        "lever": (lambda d: d, "createdAt"),
        "ashby": (lambda d: d.get("jobs"), "publishedAt"),
        "workable": (lambda d: d.get("jobs"), "published_on"),
        "smartrecruiters": (lambda d: d.get("content"), "releasedDate"),
        "recruitee": (lambda d: d.get("offers"), "published_at"),
        "bamboohr": (lambda d: d.get("result"), None),
    }[vendor]
    try:
        jobs = rows(data)
    except AttributeError:
        return None
    if not isinstance(jobs, list):
        return None
    alt = "updated_at" if vendor == "greenhouse" else None
    dates = [d for d in (_iso(j.get(key) or (j.get(alt) if alt else None)) for j in jobs if key) if d]
    count = int(data.get("totalFound", len(jobs))) if vendor == "smartrecruiters" else len(jobs)
    return count, max(dates) if dates else None


def check_board(c: httpx.Client, vendor: str, slug: str) -> dict | None:
    """Board details if the board exists, else None."""
    _, api, board = VENDORS[vendor]
    url = board.format(slug=slug)
    if api:
        data = get_json(c, api.format(slug=slug))
        got = _jobs(vendor, data) if data is not None else None
        if got is None:
            return None
        return {"vendor": vendor, "slug": slug, "url": url, "jobs_open": got[0], "newest_posted": got[1]}
    status, _, _ = get_text(c, url)
    if status != 200:
        return None
    return {"vendor": vendor, "slug": slug, "url": url, "jobs_open": None, "newest_posted": None}


def compute_ats(store: Store, domain: str) -> dict:
    found: dict[tuple[str, str], str] = {}
    with client() as c:
        for path in CAREERS:
            status, final, html = get_text(c, f"https://{domain}{path}")
            if status != 200:
                continue
            for hit in find_links(final):
                found.setdefault(hit, "site")
            if same_site(final, domain):
                for hit in find_links(html):
                    found.setdefault(hit, "site")
        label = domain.split(".")[0]
        if len(label) >= 4:
            for vendor in GUESS_VENDORS:
                found.setdefault((vendor, label), "guess")
        boards = []
        for (vendor, slug), via in sorted(found.items()):
            b = check_board(c, vendor, slug)
            if b and (via == "site" or (b["jobs_open"] or 0) > 0):
                boards.append({**b, "found_via": via})
    payload = {
        "status": "ready" if boards else "no_boards",
        "domain": domain,
        "boards": boards,
        "computed_at": int(time.time()),
    }
    store.write(f"ats/{domain}.json", payload)
    return payload


# -- Common Crawl board index ---------------------------------------------
CC = "https://data.commoncrawl.org/cc-index/collections/{crawl}/indexes/{file}"


def latest_crawl(c: httpx.Client) -> str:
    data = get_json(c, "https://index.commoncrawl.org/collinfo.json")
    if not isinstance(data, list) or not data:
        raise RuntimeError("collinfo.json unavailable")
    return data[0]["id"]


def _blocks(lines: list[tuple[str, str, int, int]], prefix: str) -> list[tuple[str, int, int]]:
    """Index blocks that can hold keys starting with `prefix` (the block before the first match too)."""
    keys = [k for k, *_ in lines]
    lo = max(bisect.bisect_left(keys, prefix) - 1, 0)
    hi = bisect.bisect_left(keys, prefix + "\U0010ffff")
    return [(s, o, n) for _, s, o, n in lines[lo : max(hi, lo + 1)]]


def slug_from(row: str, prefix: str, mode: str) -> str | None:
    if not row.startswith(prefix):
        return None
    rest = row[len(prefix) :].split(" ", 1)[0]
    if mode == "path":
        m = re.match(r"([a-z0-9][a-z0-9_.-]{0,80})", rest)
    else:
        m = re.match(r"([a-z0-9][a-z0-9-]{0,62})\)", rest)
    slug = m.group(1) if m else None
    return slug if slug and slug not in NOT_SLUGS else None


def _range(c: httpx.Client, url: str, off: int, length: int) -> bytes:
    for attempt in range(5):
        try:
            r = c.get(url, headers={"Range": f"bytes={off}-{off + length - 1}"})
            if r.content[:2] == b"\x1f\x8b":
                return r.content
        except httpx.HTTPError:
            pass
        time.sleep(3 * (attempt + 1))  # data.commoncrawl.org answers 503 SlowDown when busy
    return b""


def build_index(store: Store, crawl: str | None = None) -> dict:
    with client(timeout=120) as c:
        crawl = crawl or latest_crawl(c)
        idx = c.get(CC.format(crawl=crawl, file="cluster.idx"))
        idx.raise_for_status()
        lines = []
        for ln in idx.text.splitlines():
            parts = ln.split("\t")
            if len(parts) >= 4:
                lines.append((parts[0].split(" ", 1)[0], parts[1], int(parts[2]), int(parts[3])))
        lines.sort()
        stats = {}
        for vendor, prefixes in INDEX_PREFIXES.items():
            slugs: dict[str, int] = {}
            for prefix, mode in prefixes:
                for shard, off, n in _blocks(lines, prefix):
                    raw = _range(c, CC.format(crawl=crawl, file=shard), off, n)
                    for row in gzip.decompress(raw).decode("utf-8", "replace").splitlines() if raw else []:
                        s = slug_from(row, prefix, mode)
                        if s:
                            slugs[s] = slugs.get(s, 0) + 1
            store.write(f"ats/index/{crawl}/{vendor}.json", {"vendor": vendor, "crawl": crawl, "slugs": slugs})
            stats[vendor] = len(slugs)
    meta = {"crawl": crawl, "built_at": int(time.time()), "boards": stats}
    store.write("ats/index/current.json", meta)
    return meta


def index_boards(store: Store, vendor: str, offset: int, limit: int) -> dict | None:
    cur = store.read("ats/index/current.json")
    if not cur:
        return None
    data = store.read(f"ats/index/{cur['crawl']}/{vendor}.json") or {"slugs": {}}
    ranked = sorted(data["slugs"].items(), key=lambda kv: (-kv[1], kv[0]))
    board = VENDORS[vendor][2]
    return {
        "vendor": vendor,
        "crawl": cur["crawl"],
        "total": len(ranked),
        "boards": [
            {"slug": s, "url": board.format(slug=s), "pages_seen": n} for s, n in ranked[offset : offset + limit]
        ],
    }
