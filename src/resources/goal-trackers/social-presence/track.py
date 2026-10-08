#!/usr/bin/env python3
"""Focus tracker: LinkedIn + X posts, replies, engagement, impressions, followers.

Reports one snapshot a day to Focus:  POST {gateway}/api/workspace/focus/metrics
Never invents numbers: a source that can't be read reports null + the reason.

Sources (whichever the user connected — Platform Connections keys or legacy custom keys):
  LinkedIn  LINKEDIN_LI_AT              → Papr-managed Chrome over CDP (papr_platform_browser), the
                                          supported LinkedIn path; headless cookies as a fallback.
  X         TWITTER_AUTH_TOKEN/_CT0  or  X_AUTH_TOKEN/X_CT0
                                        → `bird` CLI when installed, else headless Playwright that
                                          reads the profile timeline the page itself loads.
Reads at most ~4 pages per platform per day — far under platform rate limits.

Usage: python3 track.py --goal <focus goal id> [--dry-run]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

NOW = datetime.now(timezone.utc)
WEEK_AGO = NOW - timedelta(days=7)
GATEWAY = os.environ.get("PAPR_GATEWAY") or f"http://127.0.0.1:{os.environ.get('GATEWAY_PORT', '18789')}"


def log(msg: str) -> None:
    print(f"[tracker] {msg}", flush=True)


def env(*names: str) -> str:
    for n in names:
        v = os.environ.get(n, "").strip()
        if v and not v.startswith("${"):
            return v
    return ""


def li_activity_time(activity_id: str) -> datetime | None:
    """LinkedIn activity ids are snowflakes: the top 41 bits are epoch milliseconds."""
    try:
        return datetime.fromtimestamp((int(activity_id) >> 22) / 1000, tz=timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None


def x_time(s: str) -> datetime | None:
    for fmt in ("%a %b %d %H:%M:%S %z %Y", "%Y-%m-%dT%H:%M:%S.%fZ"):
        try:
            d = datetime.strptime(s, fmt)
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
    return None


# ---------------------------------------------------------------- X


def find_bird() -> str | None:
    found = shutil.which("bird")
    if found:
        return found
    nvm = Path.home() / ".nvm" / "versions" / "node"
    if nvm.exists():
        for d in sorted(nvm.iterdir(), reverse=True):
            if (d / "bin" / "bird").exists():
                return str(d / "bin" / "bird")
    return None


def x_avatar(user: dict) -> str:
    """Profile picture from an X user result (new `avatar` or legacy field), upsized from 48px."""
    url = (user.get("avatar") or {}).get("image_url") or (user.get("legacy") or {}).get("profile_image_url_https") or ""
    return url.replace("_normal.", "_400x400.") if url.startswith("https://") else ""


def summarize_x(tweets: list[dict], me: str, followers: int | None, avatar: str = "", name: str = "") -> dict:
    """tweets: normalized {id, at, text, likes, replies, reposts, views, is_rt, is_reply, author}."""
    mine = [t for t in tweets if t["author"].lower() == me.lower() and t["at"] and t["at"] >= WEEK_AGO]
    posts = [t for t in mine if not t["is_rt"] and not t["is_reply"]]
    replies = [t for t in mine if t["is_reply"]]
    views = [t["views"] for t in posts if isinstance(t["views"], int)]
    return {
        "posts7": len(posts),
        "replies7": len(replies),
        "engagement7": sum(t["likes"] + t["replies"] + t["reposts"] for t in posts),
        "impressions7": sum(views) if views else None,
        "followers": followers,
        "days": sorted({t["at"].date().isoformat() for t in posts}),
        # Who the numbers belong to — the goal page shows this face instead of a platform label.
        "profile": {"handle": me, "name": name or me, "url": f"https://x.com/{me}", "followers": followers,
                    "avatar": avatar or f"https://unavatar.io/x/{me}"},
        "items": [
            {"source": "x", "kind": "post", "url": f"https://x.com/{me}/status/{t['id']}", "text": t["text"][:140],
             "at": t["at"].isoformat(), "engagement": t["likes"] + t["replies"] + t["reposts"], "impressions": t["views"]}
            for t in posts[:10]
        ],
    }


def x_via_bird(bird: str, auth: str, ct0: str) -> dict:
    base = [bird, "--auth-token", auth, "--ct0", ct0]
    who = subprocess.run(base + ["--plain", "whoami"], capture_output=True, text=True, timeout=30)
    me = next((ln.split("@", 1)[1].split()[0] for ln in who.stdout.splitlines() if ln.startswith("user:") and "@" in ln), "")
    if not me:
        raise RuntimeError(f"bird whoami failed: {(who.stderr or who.stdout)[:160]}")
    tweets: list[dict] = []
    followers, avatar, name = None, "", ""
    for cmd in (["user-tweets", me, "-n", "40", "--json-full"], ["search", f"from:{me} filter:replies", "-n", "40", "--json-full"]):
        r = subprocess.run(base + cmd, capture_output=True, text=True, timeout=60)
        try:
            data = json.loads(r.stdout or "[]")
        except json.JSONDecodeError:
            log(f"x: bird {cmd[0]} returned no JSON: {r.stderr[:160]}")
            continue
        for t in data if isinstance(data, list) else data.get("tweets", []):
            raw = t.get("_raw") or {}
            legacy = raw.get("legacy") or {}
            views = (raw.get("views") or {}).get("count")
            user = ((raw.get("core") or {}).get("user_results") or {}).get("result") or {}
            ul = user.get("legacy") or {}
            if (t.get("author") or {}).get("username", "").lower() == me.lower() and isinstance(ul.get("followers_count"), int):
                followers = ul["followers_count"]
                avatar = avatar or x_avatar(user)
                name = name or (user.get("core") or {}).get("name") or ul.get("name") or ""
            text = t.get("text") or ""
            tweets.append({
                "id": t.get("id"), "at": x_time(t.get("createdAt") or ""), "text": text,
                "likes": int(t.get("likeCount") or 0), "replies": int(t.get("replyCount") or 0),
                "reposts": int(t.get("retweetCount") or 0), "views": int(views) if str(views or "").isdigit() else None,
                "is_rt": text.startswith("RT @") or bool(legacy.get("retweeted_status_result")),
                "is_reply": bool(legacy.get("in_reply_to_status_id_str")) or cmd[0] == "search",
                "author": (t.get("author") or {}).get("username") or me,
            })
    seen, uniq = set(), []
    for t in tweets:
        if t["id"] not in seen:
            seen.add(t["id"])
            uniq.append(t)
    return summarize_x(uniq, me, followers, avatar, name)


async def x_via_playwright(auth: str, ct0: str) -> dict:
    """Read the profile timeline the X web app loads (no hardcoded GraphQL query ids)."""
    from playwright.async_api import async_playwright

    payloads: list[dict] = []
    async with async_playwright() as pw:
        browser = await launch_headless(pw)
        ctx = await browser.new_context()
        await ctx.add_cookies([
            {"name": "auth_token", "value": auth, "domain": ".x.com", "path": "/", "secure": True, "httpOnly": True},
            {"name": "ct0", "value": ct0, "domain": ".x.com", "path": "/", "secure": True},
        ])
        page = await ctx.new_page()

        async def on_response(resp):
            if "/graphql/" in resp.url and ("UserTweets" in resp.url or "UserTweetsAndReplies" in resp.url):
                try:
                    payloads.append(await resp.json())
                except Exception:
                    pass

        page.on("response", on_response)
        await page.goto("https://x.com/home", wait_until="domcontentloaded", timeout=45000)
        twid = next((c["value"] for c in await ctx.cookies() if c["name"] == "twid"), "")
        uid = twid.replace("u%3D", "").replace("u=", "")
        if not uid:
            raise RuntimeError("not signed in to X (no twid cookie)")
        await page.goto(f"https://x.com/i/user/{uid}", wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(5000)
        me = page.url.rstrip("/").split("/")[-1]
        await page.goto(f"https://x.com/{me}/with_replies", wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(5000)
        await browser.close()

    tweets, followers, avatar, pname = [], None, "", ""

    def walk(o):
        if isinstance(o, dict):
            if o.get("__typename") == "Tweet" and isinstance(o.get("legacy"), dict):
                yield o
            for v in o.values():
                yield from walk(v)
        elif isinstance(o, list):
            for v in o:
                yield from walk(v)

    for p in payloads:
        for tw in walk(p):
            lg = tw["legacy"]
            user = ((tw.get("core") or {}).get("user_results") or {}).get("result") or {}
            name = (user.get("core") or {}).get("screen_name") or (user.get("legacy") or {}).get("screen_name") or ""
            if name.lower() == me.lower() and isinstance((user.get("legacy") or {}).get("followers_count"), int):
                followers = user["legacy"]["followers_count"]
                avatar = avatar or x_avatar(user)
                pname = pname or (user.get("core") or {}).get("name") or (user.get("legacy") or {}).get("name") or ""
            views = (tw.get("views") or {}).get("count")
            tweets.append({
                "id": tw.get("rest_id"), "at": x_time(lg.get("created_at", "")), "text": lg.get("full_text", ""),
                "likes": lg.get("favorite_count", 0), "replies": lg.get("reply_count", 0), "reposts": lg.get("retweet_count", 0),
                "views": int(views) if str(views or "").isdigit() else None,
                "is_rt": "retweeted_status_result" in lg, "is_reply": bool(lg.get("in_reply_to_status_id_str")), "author": name,
            })
    uniq = list({t["id"]: t for t in tweets}.values())
    return summarize_x(uniq, me, followers, avatar, pname)


# ---------------------------------------------------------------- LinkedIn

VOYAGER_FETCH = r"""async (path) => {
  const t = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1];
  const r = await fetch(path, { headers: { 'csrf-token': t, accept: 'application/vnd.linkedin.normalized+json+2.1',
    'x-restli-protocol-version': '2.0.0' } });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}"""


def li_picture(me_body: dict) -> str:
    """Largest profile picture in /voyager/api/me (miniProfile.picture vector image), or ''."""
    for o in me_body.get("included", []) if isinstance(me_body, dict) else []:
        pic = o.get("picture") or (o.get("profilePicture") or {}).get("displayImageReference") or {}
        vec = pic.get("com.linkedin.common.VectorImage") or pic.get("vectorImage") or pic
        root, arts = vec.get("rootUrl"), vec.get("artifacts") or []
        if root and arts:
            best = max(arts, key=lambda a: a.get("width") or 0)
            return root + (best.get("fileIdentifyingUrlPathSegment") or "")
    return ""


def summarize_linkedin(feed: dict, followers: int | None, my_urn: str) -> dict:
    """Tolerant parse of profileUpdatesV2: social counts are keyed by the activity urn."""
    counts: dict[str, dict] = {}
    authored: set[str] = set()
    texts: dict[str, str] = {}
    for o in feed.get("included", []):
        urn = o.get("entityUrn") or o.get("urn") or ""
        act = urn.split("urn:li:activity:")[-1].split(",")[0].rstrip(")") if "urn:li:activity:" in urn else ""
        if not act.isdigit():
            continue
        if "numLikes" in o or "numComments" in o:
            counts[act] = o
        actor = json.dumps(o.get("actor") or {})
        if my_urn and my_urn in actor and not o.get("resharedUpdate"):
            authored.add(act)
        commentary = ((o.get("commentary") or {}).get("text") or {}).get("text")
        if commentary:
            texts[act] = commentary
    posts = []
    for act in (authored or set(counts)):
        at = li_activity_time(act)
        if not at or at < WEEK_AGO:
            continue
        c = counts.get(act, {})
        eng = int(c.get("numLikes") or 0) + int(c.get("numComments") or 0) + int(c.get("numShares") or 0)
        imp = c.get("numImpressions")
        posts.append({"id": act, "at": at, "eng": eng, "imp": imp if isinstance(imp, int) else None})
    imps = [p["imp"] for p in posts if p["imp"] is not None]
    return {
        "posts7": len(posts),
        "replies7": None,  # LinkedIn comments you wrote aren't in the share feed; not guessed.
        "engagement7": sum(p["eng"] for p in posts),
        "impressions7": sum(imps) if imps else None,
        "followers": followers,
        "days": sorted({p["at"].date().isoformat() for p in posts}),
        "items": [
            {"source": "linkedin", "kind": "post", "url": f"https://www.linkedin.com/feed/update/urn:li:activity:{p['id']}/",
             "text": texts.get(p["id"], "")[:140], "at": p["at"].isoformat(), "engagement": p["eng"], "impressions": p["imp"]}
            for p in sorted(posts, key=lambda p: p["at"], reverse=True)[:10]
        ],
    }


async def linkedin_from_page(page) -> dict:
    me = await page.evaluate(VOYAGER_FETCH, "/voyager/api/me")
    if me["status"] != 200:
        raise RuntimeError(f"LinkedIn /me HTTP {me['status']} (signed out?)")
    prof = next((x for x in me["body"].get("included", []) if "publicIdentifier" in x), {})
    fsd = (prof.get("dashEntityUrn") or prof.get("entityUrn") or "").split(":")[-1]
    public_id = prof.get("publicIdentifier", "")
    feed = await page.evaluate(
        VOYAGER_FETCH,
        "/voyager/api/identity/profileUpdatesV2?count=40&includeLongTermHistory=true"
        f"&moduleKey=creator_profile_all_content_view%3Adesktop&numComments=0&profileUrn=urn%3Ali%3Afsd_profile%3A{fsd}"
        "&q=memberShareFeed&start=0",
    )
    if feed["status"] != 200:
        raise RuntimeError(f"LinkedIn share feed HTTP {feed['status']}")
    net = await page.evaluate(VOYAGER_FETCH, f"/voyager/api/identity/profiles/{public_id}/networkinfo")
    followers = ((net.get("body") or {}).get("data") or {}).get("followersCount") if net["status"] == 200 else None
    out = summarize_linkedin(feed["body"], followers if isinstance(followers, int) else None, fsd)
    name = " ".join(filter(None, [prof.get("firstName"), prof.get("lastName")])) or public_id
    out["profile"] = {"handle": public_id, "name": name, "url": f"https://www.linkedin.com/in/{public_id}/",
                      "followers": out["followers"], "avatar": li_picture(me["body"])}
    return out


async def linkedin() -> dict:
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        try:  # Supported path: Papr-managed Chrome (job requirement "linkedin-api" starts it).
            sys.path.insert(0, os.environ.get("PAPR_JOB_SDK_DIR", ""))
            from papr_platform_browser import connect_platform_browser

            browser, page = await connect_platform_browser(pw, "linkedin.com")
            if "linkedin.com" not in (page.url or ""):
                await page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=45000)
            return await linkedin_from_page(page)
        except ImportError:
            log("linkedin: papr_platform_browser not available, trying headless cookies")
        except Exception as e:  # noqa: BLE001 — fall through to headless with the reason logged
            log(f"linkedin: Papr Chrome unavailable ({str(e)[:120]}), trying headless cookies")
        browser = await launch_headless(pw)
        ctx = await browser.new_context(user_agent=(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/141.0.0.0 Safari/537.36"), locale="en-US")
        cookies = [{"name": "li_at", "value": env("LINKEDIN_LI_AT"), "domain": ".linkedin.com", "path": "/",
                    "secure": True, "httpOnly": True}]
        jsid = env("LINKEDIN_JSESSIONID").strip('"')
        if jsid:  # Voyager reads JSESSIONID as the csrf token; li_at alone redirect-loops.
            cookies.append({"name": "JSESSIONID", "value": f'"{jsid}"', "domain": ".www.linkedin.com", "path": "/",
                            "secure": True})
        await ctx.add_cookies(cookies)
        page = await ctx.new_page()
        await page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=45000)
        try:
            return await linkedin_from_page(page)
        finally:
            await browser.close()


async def launch_headless(pw):
    try:
        return await pw.chromium.launch(headless=True)
    except Exception:  # bundled Chromium missing/mismatched → system Chrome
        return await pw.chromium.launch(headless=True, channel="chrome")


# ---------------------------------------------------------------- main


def combine(parts: dict[str, dict]) -> dict:
    def total(k):
        vals = [p[k] for p in parts.values() if isinstance(p.get(k), int)]
        return sum(vals) if vals else None

    summary = {k: total(k) for k in ("posts7", "replies7", "engagement7", "impressions7", "followers")}
    # Habit view: days this week with a post on every connected platform ("1 post on X and LinkedIn daily").
    day_sets = [set(p.get("days", [])) for p in parts.values()]
    summary["days_hit7"] = len(set.intersection(*day_sets)) if day_sets else None
    for src, p in parts.items():
        for k in ("posts7", "engagement7", "impressions7", "followers"):
            summary[f"{'li' if src == 'linkedin' else src}_{k}"] = p.get(k)
    return summary


def post_metrics(goal: str, summary: dict, sources: dict, items: list) -> None:
    body = json.dumps({"goalId": goal, "template": "social-presence", "summary": summary,
                       "sources": sources, "items": items}).encode()
    req = urllib.request.Request(f"{GATEWAY}/api/workspace/focus/metrics", body, {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code != 404 or not os.environ.get("PAPR_HOME"):
            raise
        # Older Paprwork without the metrics endpoint: leave the snapshot where Focus will read it.
        out = Path(os.environ["PAPR_HOME"]) / "workspace" / "goals" / "metrics" / f"{goal}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"goalId": goal, "template": "social-presence", "updatedAt": NOW.isoformat(),
                                   "summary": summary, "sources": sources, "items": items[:30]}, indent=2))
        log(f"metrics endpoint missing; wrote {out}")
        return
    if res.get("error"):
        raise RuntimeError(res["error"])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--goal", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    parts: dict[str, dict] = {}
    sources: dict[str, dict] = {}

    x_auth, x_ct0 = env("TWITTER_AUTH_TOKEN", "X_AUTH_TOKEN"), env("TWITTER_CT0", "X_CT0")
    if x_auth and x_ct0:
        try:
            bird = find_bird()
            parts["x"] = x_via_bird(bird, x_auth, x_ct0) if bird else asyncio.run(x_via_playwright(x_auth, x_ct0))
            sources["x"] = {"ok": True, "profile": parts["x"].pop("profile", None)}
            log(f"x: {parts['x']['posts7']} posts, {parts['x']['replies7']} replies, {parts['x']['engagement7']} engagement")
        except Exception as e:  # noqa: BLE001
            sources["x"] = {"ok": False, "error": str(e)[:200]}
            log(f"x: failed — {e}")
    else:
        sources["x"] = {"ok": False, "error": "not connected"}

    if env("LINKEDIN_LI_AT"):
        try:
            parts["linkedin"] = asyncio.run(linkedin())
            sources["linkedin"] = {"ok": True, "profile": parts["linkedin"].pop("profile", None)}
            log(f"linkedin: {parts['linkedin']['posts7']} posts, {parts['linkedin']['engagement7']} engagement")
        except Exception as e:  # noqa: BLE001
            sources["linkedin"] = {"ok": False, "error": str(e)[:200]}
            log(f"linkedin: failed — {e}")
    else:
        sources["linkedin"] = {"ok": False, "error": "not connected"}

    if not parts:
        log(f"no source readable: {json.dumps(sources)}")
        if not args.dry_run:
            post_metrics(args.goal, {}, sources, [])
        return 1

    summary = combine(parts)
    items = sorted((i for p in parts.values() for i in p.get("items", [])), key=lambda i: i["at"], reverse=True)
    log("summary " + json.dumps(summary))
    if args.dry_run:
        return 0
    post_metrics(args.goal, summary, sources, items)
    log("SUCCESS reported to Focus")
    return 0


if __name__ == "__main__":
    sys.exit(main())
