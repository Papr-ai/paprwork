---
id: preloaded-social-media-auth
name: Social Media Authentication
description: Rate limiting guidelines and best practices for social media automation jobs using Connected Platforms.
---
# Social Media & Platform Connections Guide

Use **Settings → Platform Connections** or the `connect_platform` tool for built-in social sites and custom login-required URLs.

## Register a custom site (agent)

```typescript
connect_platform({
  action: "register",
  url: "https://app.example.com",
  name: "Example App",
})
// → platformId like site-app-example-com

connect_platform({ platform: "site-app-example-com", action: "request_connect", reason: "..." })
connect_platform({ platform: "site-app-example-com", action: "prepare_browser" })
browser_snapshot({})
```

## Built-in platforms

```typescript
connect_platform({ platform: "linkedin", action: "status" })
connect_platform({ platform: "reddit", action: "status" })
connect_platform({ platform: "linkedin", action: "prepare_browser" })
browser_snapshot({})
```

**Connect vs job runtime:**
- **Connected** = required cookies saved to **keychain** (and `cookies.json`). Jobs use `${KEY_NAME}` substitution. Cloud jobs read from **cloud vault** — desktop must push vault while awake (Cloud Sync on).
- **Papr Chrome** (desktop) = sign-in UI. **LinkedIn always.** Other platforms only when personal Chrome has no session. **Not required as job runtime** for X/Reddit/Instagram scrapers.

**Desktop:** `prepare_browser` uses real Papr-managed Chrome when installed (headless Playwright + keychain cookies in cloud). Then use browser_* tools.

## Job automation by platform (READ THIS)

| Platform | Connect | Python/bash scrape jobs | Agent jobs / chat |
|----------|---------|-------------------------|-------------------|
| **LinkedIn** | Papr Chrome sign-in only | `requirements: ["linkedin-api", "playwright"]` + `papr_platform_browser.connect_platform_browser()` (CDP :9222) | `prepare_browser` → `browser_*` |
| **X, Reddit, Instagram, …** | Personal Chrome import OK → keychain | **`${TWITTER_*}` / `${REDDIT_*}` / `${INSTAGRAM_*}` + headless Playwright, requests, or bash curl.** Do **NOT** use `reddit-api`, `x-api`, or Papr Chrome CDP. | `prepare_browser` (headless in cloud) → `browser_*` |
| **Cloud (non-LinkedIn)** | Vault-synced keys | Same — headless + `${KEY}`. No :9222. | `prepare_browser` + headless `browser_*` |

## Agent browser automation (chat + agent jobs)

**Flow:** `prepare_browser` → `browser_snapshot` (see HTML) → `browser_click` / `browser_type` → repeat.

| Tool | Purpose |
|------|---------|
| `browser_snapshot` | **How you see the page** — returns HTML; find CSS selectors here |
| `browser_navigate` | Go to a URL (logged-in session persists) |
| `browser_click` / `browser_type` / `browser_fill_form` | Interact with elements |
| `browser_scroll` | Scroll by direction/delta (scroll-into-view selector fails on embedded Electron fallback only) |
| `browser_test_script` | Run JS on page, return data |
| `browser_network_logs` / `browser_console_logs` | Debug APIs and JS errors |
| `page_wait_for({ target: "browser", time: N })` | Wait for SPA render — works everywhere; on embedded Electron fallback use **time only** (no text/selector) |

**Embedded Electron fallback only** (Google Chrome not installed): `page_wait_for` with `text` or `selector` fails — use snapshot + click instead. Papr Chrome and headless Playwright support text/selector waits.

**Prefer browser tools** over bash/curl for LinkedIn/social (curl still works but often returns empty — a tip is appended).

**Passkey / 2FA:** Connect and `prepare_browser` on desktop open **Papr-managed Chrome** — passkeys, Touch ID, and OAuth work normally. Embedded Electron fallback (no Chrome installed) cannot show passkeys — user must click **Try another way** → password/SMS.

**No HTTP API** — no `/api/browser`. Desktop Papr only (IPC).

| Runtime | LinkedIn | X, Reddit, Instagram, … |
|---------|----------|-------------------------|
| **Python scrape job** | `requirements: ["linkedin-api", "playwright"]` → `papr_platform_browser.connect_platform_browser()` (CDP to Papr Chrome :9222) | `${REDDIT_REDDIT_SESSION}`, `${TWITTER_AUTH_TOKEN}`, etc. + **headless Playwright** or `requests`/`curl`. **No `*-api` CDP.** |
| **Agent/subagent job** | `prepare_browser` + `browser_*` | `prepare_browser` + `browser_*` (cookies from keychain; headless in cloud) |
| **Cloud jobs** | Cookie-only often blocked | Vault keys + headless Playwright ✅ |
| **HTTP / mini-app** | No `/api/browser` | No `/api/browser` |

**There is no job-facing HTTP API for platform browsers.** Agents use IPC tools; LinkedIn Python jobs use CDP; other platforms use `${KEY}` + headless Playwright.

**LinkedIn Python scraper (CDP — desktop only):**
```python
from playwright.async_api import async_playwright
from papr_platform_browser import connect_platform_browser

async with async_playwright() as pw:
    browser, page = await connect_platform_browser(pw, "linkedin.com")
    await page.goto("https://www.linkedin.com/feed/")
    # scrape — reuse logged-in tab; never browser.new_page()
```

```typescript
create_job({
  name: "LinkedIn Scraper",
  type: "python",
  command: "python3 code/scraper.py",
  requirements: ["linkedin-api", "playwright"],
})
```

**Reddit / X Python scraper (headless + keychain — preferred for non-LinkedIn):**
```python
from playwright.async_api import async_playwright

async def scrape(session: str):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context()
        await context.add_cookies([{
            "name": "reddit_session",
            "value": session,
            "domain": ".reddit.com",
            "path": "/",
        }])
        page = await context.new_page()
        await page.goto("https://www.reddit.com/")
```

```typescript
create_job({
  name: "Reddit Scraper",
  type: "python",
  command: "python3 code/scraper.py --session '${REDDIT_REDDIT_SESSION}'",
  requirements: ["playwright"], // NO reddit-api
})
```

**Papr Chrome on :9222:** Used for LinkedIn CDP jobs and desktop sign-in. Do not require it for Reddit/X/Instagram scheduled scrapers.

**OAuth login (Google/Apple/Microsoft on LinkedIn):** Connect opens real Papr Chrome — passkeys and OAuth work normally.

**If `prepare_browser` times out:** confirm desktop Papr, Platform Connections connected, retry after `connect_platform({ action: "refresh" })`.

## Discovering backend APIs

After `prepare_browser`, use DevTools-style logs (`browser_network_logs`, `browser_console_logs`) on Papr Chrome, headless Playwright, or embedded Electron fallback:

```typescript
connect_platform({ platform: "site-app-example-com", action: "prepare_browser" })
browser_network_logs({ limit: 20, clearAfterRead: true })
browser_navigate({ url: "https://app.example.com/dashboard" })
page_wait_for({ target: "browser", time: 3 })
browser_network_logs({ limit: 100 }) // filter resourceType xhr/fetch
browser_console_logs({ limit: 50 })
```

Use discovered endpoints to design Python/bash jobs with `${SITE_*_COOKIE}` keys, or keep using browser_* tools.

**LinkedIn / strict platforms:** network logs help debug UI flows — do **not** replay internal Voyager/GraphQL APIs via curl (stale query IDs, bot detection).

## Cookie Key Names

Use these in job commands with `${KEY_NAME}` substitution:

| Platform | Cookie Keys |
|----------|-------------|
| LinkedIn | `LINKEDIN_LI_AT`, `LINKEDIN_JSESSIONID` |
| Instagram | `INSTAGRAM_SESSIONID`, `INSTAGRAM_CSRFTOKEN` |
| Facebook | `FACEBOOK_C_USER`, `FACEBOOK_XS` |
| TikTok | `TIKTOK_SESSIONID`, `TIKTOK_SID_TT` |
| Reddit | `REDDIT_REDDIT_SESSION`, `REDDIT_TOKEN_V2` |
| X/Twitter | `TWITTER_AUTH_TOKEN`, `TWITTER_CT0` |

**For X/Twitter jobs:** Prefer `${TWITTER_AUTH_TOKEN}` + headless Playwright or the `bird` CLI (reads stored cookies). Do not use `x-api` CDP for scrapers.

**For Reddit/Instagram jobs:** Pass cookie keys as CLI args (`'${REDDIT_REDDIT_SESSION}'`) and launch headless Playwright — do not use `reddit-api` / `instagram-api` CDP.

## CRITICAL: Rate Limiting Required

**Failure to rate limit = Account ban!**

When creating ANY job that uses social media cookies:
- Max 1-3 posts per day (not every hour!)
- Add random delays (2-30 seconds between actions)
- Vary posting times (don't post at exact same time daily)

## Recommended Schedules

| Platform | Max Frequency | Best Times | Notes |
|----------|---------------|------------|-------|
| LinkedIn | 2x daily | Business hours (9-5) | Professional content only |
| Instagram | 1x daily | 11am-1pm, 7-9pm | Avoid automated Stories |
| Facebook | 3x daily | Varied | Mix content types |
| Reddit | 4x daily | Varies by subreddit | Vary subreddits |
| TikTok | 1x daily | 7-9pm | Evening posts perform better |

## Required Safety Measures

1. **Limit posting frequency** (max 1-3x per day)
2. **Add random delays** (1-5 minutes before posting)
3. **Detect rate limits** (watch for HTTP 429, CAPTCHAs)
4. **Track posts** (avoid duplicates)
5. **Circuit breaker** (stop if errors detected)

## Detection Patterns to Avoid

These patterns trigger anti-automation detection:
- Exact timing (same second every day)
- High frequency (multiple actions per minute)
- No delays (instant responses)
- Same content repeatedly
- 24/7 activity (no sleep patterns)

## Example Job with Rate Limiting

```python
import time
import random
import requests

def post_to_linkedin(content: str, li_at: str, jsessionid: str):
    # Random delay before posting (1-5 minutes)
    delay = random.randint(60, 300)
    print(f"Waiting {delay}s before posting...")
    time.sleep(delay)
    
    # Post with cookies
    cookies = {
        "li_at": li_at,
        "JSESSIONID": jsessionid
    }
    
    # ... posting logic ...
    
    # Random delay after posting
    time.sleep(random.randint(5, 30))

# Use in job with ${KEY} substitution
# create_job({ command: "python3 post.py --li-at '${LINKEDIN_LI_AT}' --jsession '${LINKEDIN_JSESSIONID}'" })
```

## Session Expiration

Typical session durations:
- LinkedIn: ~45 days (rotates tokens more frequently)
- Instagram: ~90 days
- Facebook: ~90 days
- Reddit: ~30 days
- TikTok: ~30 days

Sessions refresh automatically via the background session keeper. If a session expires, you'll see `status: "needs_reauth"` - direct user to Settings → Platforms → Reconnect.

## Security Best Practices

- Cookies are stored in the system keychain (encrypted)
- Never log or expose cookie values
- Always get user consent before posting on their behalf
- Monitor for checkpoint/verification screens
- Handle 2FA gracefully (user must complete manually)
