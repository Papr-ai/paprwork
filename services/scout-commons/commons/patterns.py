"""Company email *patterns* (first.last, flast, …) from public first-party sources.

For a domain the worker reads a few of the company's own pages (homepage,
contact, about, team, press, imprint, privacy). When COMMONS_GITHUB_TOKEN is
set it also reads recent commits in the GitHub org that the company's own
homepage links to. Each address on the company's domain is matched against the
names on the same page (or the commit author's name) to see which pattern
produced it.

Stored per domain:
- the winning pattern
- how many distinct addresses support it, and how many disagree
- up to 10 source URLs
- the mail provider, from public MX records

**Addresses are never stored, returned or logged.** They exist only in memory
while a page is scanned. Role addresses (info@, sales@ …) are ignored. Domains
on the opt-out list are never computed or served.
"""

from __future__ import annotations

import html as htmlmod
import os
import re
import time
import unicodedata

import httpx

from .http import client, get_json, get_text, same_site
from .store import Store

# Order breaks ties: the more specific pattern wins.
PATTERNS = ("first.last", "first_last", "firstlast", "last.first", "flast", "firstl", "first")
TTL_S = 90 * 86400
PAGES = (
    "/",
    "/contact",
    "/contact-us",
    "/about",
    "/about-us",
    "/team",
    "/our-team",
    "/company",
    "/press",
    "/imprint",
    "/impressum",
    "/legal",
    "/privacy",
)
ROLE = frozenset(
    "info hello hi contact sales support help admin office team press media pr news careers jobs hr "
    "privacy legal billing accounts accounting finance security abuse noreply no-reply donotreply "
    "marketing partners partnerships enquiries inquiries dpo gdpr feedback webmaster postmaster "
    "investors ir service customerservice orders shop booking bookings events community".split()
)
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_NAME = re.compile(
    r"\b([A-ZÀ-Þ][a-zß-ÿ]+(?:-[A-ZÀ-Þ][a-zß-ÿ]+)?)\s+(?:[A-Z]\.\s+)?([A-ZÀ-Þ][a-zß-ÿ']+(?:-[A-ZÀ-Þ][a-zß-ÿ]+)?)\b"
)
_TAG = re.compile(r"<(script|style)\b.*?</\1>|<[^>]+>", re.S | re.I)
_GH = re.compile(r"https?://(?:www\.)?github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?=[\"'/?#\s<]|$)")
_GH_RESERVED = frozenset(
    "about features pricing sponsors login join orgs topics marketplace security enterprise site apps".split()
)


def _fold(s: str) -> str:
    return re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower())


def renderings(first: str, last: str) -> dict[str, str]:
    """Every pattern's local part for one person."""
    f, la = _fold(first), _fold(last)
    if len(f) < 2 or len(la) < 2:
        return {}
    return {
        "first.last": f"{f}.{la}",
        "first_last": f"{f}_{la}",
        "firstlast": f + la,
        "last.first": f"{la}.{f}",
        "flast": f[0] + la,
        "firstl": f + la[0],
        "first": f,
    }


def classify(local: str, names) -> str | None:
    """The single pattern that turns one of `names` into `local`, else None."""
    local = local.split("+", 1)[0].lower()
    if local in ROLE or not re.fullmatch(r"[a-z][a-z._-]{1,40}", local):
        return None
    hits = {p for first, last in names for p, v in renderings(first, last).items() if v == local}
    return next(iter(hits)) if len(hits) == 1 else None


def scan(html: str, domain: str) -> list[tuple[str, str | None]]:
    """(local part, pattern) for each address on `domain` in one page."""
    raw = htmlmod.unescape(html)
    text = htmlmod.unescape(_TAG.sub(" ", html))
    names = list(dict.fromkeys(_NAME.findall(text)))[:500]
    locals_ = {
        e.rsplit("@", 1)[0].lower() for e in _EMAIL.findall(raw) if e.rsplit("@", 1)[1].lower().rstrip(".") == domain
    }
    return [(loc, classify(loc, names)) for loc in sorted(locals_)]


def mx(c: httpx.Client, domain: str) -> tuple[str | None, bool | None]:
    data = get_json(c, "https://dns.google/resolve", params={"name": domain, "type": "MX"})
    if not isinstance(data, dict):
        return None, None
    answers = [a for a in data.get("Answer") or [] if a.get("type") == 15]
    hosts = [str(a.get("data", "")).split()[-1].rstrip(".").lower() for a in answers]
    if not hosts:
        return "none", False
    if any(h.endswith(("google.com", "googlemail.com")) for h in hosts):
        return "google", True
    if any(h.endswith("outlook.com") for h in hosts):
        return "microsoft", True
    return "other", True


def _github(c: httpx.Client, domain: str, home: str, token: str):
    """(local, pattern, repo URL) from recent commits in the org the homepage links to."""
    orgs = sorted({m.group(1) for m in _GH.finditer(home) if m.group(1).lower() not in _GH_RESERVED})
    h = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    for org in orgs[:2]:
        repos = get_json(c, f"https://api.github.com/orgs/{org}/repos", {"sort": "pushed", "per_page": 5}, h)
        for repo in repos if isinstance(repos, list) else []:
            if repo.get("fork"):
                continue
            url = f"https://api.github.com/repos/{org}/{repo.get('name')}/commits"
            commits = get_json(c, url, {"per_page": 100}, h)
            for cm in commits if isinstance(commits, list) else []:
                a = (cm.get("commit") or {}).get("author") or {}
                email, name = str(a.get("email") or "").lower(), str(a.get("name") or "").split()
                if email.endswith("@" + domain) and len(name) >= 2:
                    local = email.rsplit("@", 1)[0]
                    yield local, classify(local, [(name[0], name[-1])]), repo.get("html_url")


def compute_pattern(store: Store, domain: str) -> dict:
    by_pat: dict[str, set[str]] = {}
    src: dict[str, set[str]] = {}

    def add(local: str, pat: str | None, url: str | None) -> None:
        if pat:
            by_pat.setdefault(pat, set()).add(local)
            if url:
                src.setdefault(pat, set()).add(url)

    home = ""
    with client() as c:
        for path in PAGES:
            status, final, html = get_text(c, f"https://{domain}{path}")
            if status != 200 or not same_site(final, domain):
                continue
            if path == "/":
                home = html
            for local, pat in scan(html, domain):
                add(local, pat, final)
        token = os.environ.get("COMMONS_GITHUB_TOKEN")
        if token and home:
            for local, pat, url in _github(c, domain, home, token):
                add(local, pat, url)
        provider, mx_ok = mx(c, domain)

    total = len(set().union(*by_pat.values())) if by_pat else 0
    best = max(by_pat, key=lambda p: (len(by_pat[p]), -PATTERNS.index(p))) if by_pat else None
    n = len(by_pat[best]) if best else 0
    payload = {
        "status": "ready" if best else "no_pattern",
        "domain": domain,
        "pattern": best,
        "samples": n,
        "conflicting": total - n,
        "confidence": ("confirmed" if n >= 2 else "single") if best else None,
        "sources": sorted(src.get(best, set()))[:10] if best else [],
        "provider": provider,
        "mx_ok": mx_ok,
        "computed_at": int(time.time()),
    }
    store.write(f"patterns/{domain}.json", payload)
    return payload
