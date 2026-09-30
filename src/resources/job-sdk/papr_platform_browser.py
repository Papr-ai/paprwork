#!/usr/bin/env python3
"""Attach Playwright to Papr-managed Chrome via CDP (LinkedIn jobs only).

When a job declares `requirements: ["linkedin-api"]`, Papr:
  1. Ensures Papr-managed Chrome is running with remote debugging (default :9222)
  2. Opens or reuses a dedicated tab per platform in that Chrome window
  3. Injects env vars before the job runs

Do NOT use linkedin-api / this module for Reddit, X, Instagram, etc. — those platforms
use `${REDDIT_*}` / `${TWITTER_*}` / `${INSTAGRAM_*}` cookie keys + headless Playwright.

Usage (async Playwright):

    from playwright.async_api import async_playwright
    from papr_platform_browser import connect_platform_browser

    async with async_playwright() as pw:
        browser, page = await connect_platform_browser(pw, "linkedin.com")
        await page.goto("https://www.linkedin.com/search/results/people/?keywords=CEO")
        ...

Env (injected by job runner when requirements include linkedin-api):
  LINKEDIN_CHROME_CDP_URL   — http://127.0.0.1:9222
  PAPR_PLATFORM_CDP_URL     — same CDP endpoint
  PAPR_PLATFORM_ID          — e.g. linkedin
  PAPR_PLATFORM_BROWSER_URL — current platform tab URL when job started (optional hint)
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class PaprPlatformBrowserError(RuntimeError):
    """Could not attach Playwright to Papr-managed Chrome via CDP."""


def default_cdp_url() -> str:
    return (
        os.environ.get("PAPR_PLATFORM_CDP_URL")
        or os.environ.get("LINKEDIN_CHROME_CDP_URL")
        or "http://127.0.0.1:9222"
    )


def fetch_cdp_targets(cdp_url: str | None = None) -> list[dict[str, Any]]:
    base = (cdp_url or default_cdp_url()).rstrip("/")
    try:
        with urllib.request.urlopen(f"{base}/json/list", timeout=8) as resp:
            payload = resp.read().decode("utf-8")
            data = json.loads(payload)
            if isinstance(data, list):
                return [item for item in data if isinstance(item, dict)]
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise PaprPlatformBrowserError(
            f"Cannot reach Papr CDP at {base}. Is Papr desktop running? Connect LinkedIn "
            f"in Settings → Platform Connections first. ({exc})"
        ) from exc
    return []


def _host_matches(url: str, host_fragment: str) -> bool:
    fragment = host_fragment.lower().lstrip(".")
    try:
        hostname = urllib.parse.urlparse(url).hostname or ""
    except Exception:
        return False
    bare = hostname.lower().replace("www.", "")
    return fragment in bare or bare.endswith("." + fragment)


def find_platform_page_url(
    host_fragment: str,
    *,
    cdp_url: str | None = None,
) -> str | None:
    for target in fetch_cdp_targets(cdp_url):
        if target.get("type") != "page":
            continue
        url = str(target.get("url") or "")
        if url and _host_matches(url, host_fragment):
            return url
    return None


def _pick_platform_page(pages: list[Any], host_fragment: str) -> Any | None:
    for page in pages:
        url = getattr(page, "url", "") or ""
        if url and _host_matches(url, host_fragment):
            return page
    return None


async def connect_platform_browser(playwright: Any, host_fragment: str = "linkedin.com"):
    """Connect Playwright to Papr-managed Chrome. Returns (browser, page).

    Do NOT call browser.new_page() — that creates a fresh logged-out session.
    Always reuse the platform tab exposed over CDP.
    """
    cdp_url = default_cdp_url()
    try:
        browser = await playwright.chromium.connect_over_cdp(cdp_url)
    except Exception as exc:
        raise PaprPlatformBrowserError(
            f"Playwright connect_over_cdp failed at {cdp_url}. "
            "Use Papr desktop, connect LinkedIn in Settings → Platform Connections, "
            'and declare requirements: ["linkedin-api"] on the job. '
            f"({exc})"
        ) from exc

    all_pages: list[Any] = []
    for context in browser.contexts:
        all_pages.extend(context.pages)

    page = _pick_platform_page(all_pages, host_fragment)
    if page is not None:
        return browser, page

    hinted_url = find_platform_page_url(host_fragment, cdp_url=cdp_url)
    if hinted_url:
        for context in browser.contexts:
            for candidate in context.pages:
                if (getattr(candidate, "url", "") or "") == hinted_url:
                    return browser, candidate

    platform_id = os.environ.get("PAPR_PLATFORM_ID", host_fragment.split(".")[0])
    raise PaprPlatformBrowserError(
        f"No {host_fragment} tab on CDP at {cdp_url}. "
        f"Open Papr → Settings → Platform Connections → connect {platform_id}, "
        "keep Papr Chrome running, then re-run the job."
    )
