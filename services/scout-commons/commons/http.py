"""Polite outbound HTTP for the Commons worker.

- Identifies itself with a User-Agent that links to the README.
- Honours robots.txt for page fetches (APIs are called directly).
- Spaces requests to the same host (COMMONS_HOST_GAP_S, default 1 s).
- Reads at most 400 KB of any page.
- Refuses non-public addresses on every hop, including redirects, so a
  submitted domain can't point the worker at internal services.

Tests swap the network for an ``httpx.MockTransport`` via ``set_transport``.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import threading
import time
from urllib import robotparser
from urllib.parse import urlsplit

import httpx

UA = "PaprScoutCommons/0.1 (+https://github.com/Papr-ai/paprwork/tree/development/services/scout-commons)"
MAX_BYTES = 400_000
MIN_GAP_S = float(os.environ.get("COMMONS_HOST_GAP_S", "1.0"))
CHECK_IP = True

_transport: httpx.BaseTransport | None = None
_robots: dict[str, robotparser.RobotFileParser | None] = {}
_last: dict[str, float] = {}
_lock = threading.Lock()


def set_transport(transport: httpx.BaseTransport | None) -> None:
    global _transport
    _transport = transport
    _robots.clear()
    _last.clear()


def _public(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError):
        return True  # unresolvable: the request fails on its own
    return all(ipaddress.ip_address(str(i[4][0]).split("%", 1)[0]).is_global for i in infos)


def _guard(request: httpx.Request) -> None:
    if CHECK_IP and not _public(request.url.host):
        raise httpx.ConnectError("blocked: non-public address", request=request)


def client(timeout: float = 20.0) -> httpx.Client:
    return httpx.Client(
        transport=_transport,
        timeout=timeout,
        follow_redirects=True,
        max_redirects=5,
        headers={"User-Agent": UA},
        event_hooks={"request": [_guard]},
    )


def same_site(url: str, domain: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host == domain or host.endswith("." + domain)


def _wait(host: str) -> None:
    if MIN_GAP_S <= 0:
        return
    with _lock:
        now = time.monotonic()
        slot = max(now, _last.get(host, 0.0) + MIN_GAP_S)
        _last[host] = slot
    if slot > now:
        time.sleep(slot - now)


def allowed(c: httpx.Client, url: str) -> bool:
    p = urlsplit(url)
    base = f"{p.scheme}://{p.netloc}"
    if base not in _robots:
        rp: robotparser.RobotFileParser | None = robotparser.RobotFileParser()
        try:
            _wait(p.netloc)
            r = c.get(base + "/robots.txt")
            if r.status_code >= 400:
                rp = None  # no robots.txt: everything is allowed
            else:
                rp.parse(r.text.splitlines())
        except httpx.HTTPError:
            rp = None
        _robots[base] = rp
    rp = _robots[base]
    return True if rp is None else rp.can_fetch(UA, url)


def get_text(c: httpx.Client, url: str) -> tuple[int, str, str]:
    """(status, final_url, text). Status 0 on a network error, -1 when robots.txt disallows."""
    if not allowed(c, url):
        return -1, url, ""
    _wait(urlsplit(url).netloc)
    try:
        with c.stream("GET", url) as r:
            buf = bytearray()
            for chunk in r.iter_bytes():
                buf += chunk
                if len(buf) >= MAX_BYTES:
                    break
            return r.status_code, str(r.url), bytes(buf[:MAX_BYTES]).decode(r.encoding or "utf-8", "replace")
    except httpx.HTTPError:
        return 0, url, ""


def get_json(c: httpx.Client, url: str, params: dict | None = None, headers: dict | None = None):
    """Parsed JSON for a 200 response, else None."""
    _wait(urlsplit(url).netloc)
    try:
        r = c.get(url, params=params, headers=headers)
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    try:
        return r.json()
    except ValueError:
        return None
