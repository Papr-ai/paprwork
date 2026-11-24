#!/usr/bin/env python3
"""Save the daily brief to Focus.

Usage:
    python3 save_brief.py <brief.json>
    BRIEF_DATE_KEY=2026-08-31 python3 save_brief.py <brief.json>
    python3 save_brief.py --reviews [days]       # feedback on past briefs
    python3 save_brief.py --tasks                # open tasks with their goal chain
    python3 save_brief.py --asks                 # open asks: to you (ranked) and from you
    python3 save_brief.py --nudge <nudge.json>   # optional: suggest one rail nudge

Why this script exists
----------------------
The Focus database is Turso replica-synced. Writing it with a direct sqlite3
connection races the sync layer and the row can be silently discarded. All
writes go through the gateway's /api/focus/* endpoints, which validate the
brief, write it, and read it back. Papr Work owns Focus: no app id, no
data-source lookup.

Errors can come back with HTTP 200 and an {"error": ...} body, so every
response is checked for it. Exits non-zero on any failure and never reports
success unless the gateway read the row back.
"""
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request

# This gateway, not the default port: dev profiles (and a second install) run on other ports,
# and 18789 may be a different Papr Work. Jobs get PAPR_GATEWAY_URL; agent shells inherit GATEWAY_PORT.
GATEWAY = (
    os.environ.get("PAPR_GATEWAY_URL")
    or os.environ.get("PAPR_GATEWAY")
    or f"http://127.0.0.1:{os.environ.get('GATEWAY_PORT') or 18789}"
).rstrip("/")
DATE_KEY = os.environ.get("BRIEF_DATE_KEY") or datetime.date.today().isoformat()


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def call(method, path, body=None):
    req = urllib.request.Request(
        f"{GATEWAY}/api/focus/{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            parsed = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        die(f"gateway HTTP {e.code} on /api/focus/{path}: {e.read()[:400]!r}")
    except Exception as e:
        die(f"gateway request to /api/focus/{path} failed: {e}")

    # Errors can come back with HTTP 200 — this check is the important one.
    if isinstance(parsed, dict) and parsed.get("error"):
        die(f"gateway returned error on /api/focus/{path}: {parsed['error']}")
    return parsed


def print_reviews(days=30):
    """--reviews: the user's check/x feedback on past brief items, as JSON.

    Read by the brief prompt before ranking so dismissed items (and their
    siblings under the note's rule) are never resurfaced.
    """
    rows = call("GET", f"brief-reviews?days={int(days)}").get("rows") or []
    print(json.dumps(rows, ensure_ascii=False, indent=2))


def print_tasks():
    """--tasks: open tasks (L3 goals + entity Open Items) with their goal chain.

    Projected by the gateway from IDENTITY.md and entity pages; this is the
    candidate pool for today's priorities. Each row carries `id` — put it on
    the brief item as `task_id` so a check in Focus completes the task.
    """
    rows = call("GET", "open-tasks").get("rows") or []
    print(json.dumps(rows, ensure_ascii=False, indent=2))


def print_asks():
    """--asks: open asks between the user and teammates, from Papr.

    to_you: what teammates asked the user, with Pen + Jev's ranking (`triage.when`,
    `triage.goalId`, `triage.why`). from_you: what the user asked teammates and its
    progress. These are already tracked in Papr: never copy one into Waiting On.
    """
    print(json.dumps(call("GET", "open-asks"), ensure_ascii=False, indent=2))


def propose_nudge(path):
    """--nudge: suggest (never force) one rail nudge. The app applies its own caps
    (max 1/day, working hours, backoff) and may show it later or not at all.
    Never fails the brief: a rejected nudge only prints a warning."""
    try:
        with open(path) as f:
            nudge = json.load(f)
        nudge.setdefault("source", "daily-brief")
        nudge.setdefault("kind", "brief")
        req = urllib.request.Request(
            f"{GATEWAY}/api/nudge/propose",
            data=json.dumps(nudge).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            parsed = json.loads(resp.read())
        print(f"NUDGE queued: {parsed.get('queued', {}).get('key')}")
    except urllib.error.HTTPError as e:
        print(f"WARN: nudge not queued (HTTP {e.code}): {e.read()[:300]!r}", file=sys.stderr)
    except Exception as e:
        print(f"WARN: nudge not queued: {e}", file=sys.stderr)


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--nudge":
        propose_nudge(sys.argv[2])
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "--asks":
        print_asks()
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "--tasks":
        print_tasks()
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "--reviews":
        days = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 30
        print_reviews(days)
        return

    if len(sys.argv) < 2:
        die("usage: save_brief.py <brief.json> | save_brief.py --reviews [days] | save_brief.py --tasks | save_brief.py --asks")

    try:
        with open(sys.argv[1]) as f:
            brief = json.load(f)
    except Exception as e:
        die(f"could not read brief JSON from {sys.argv[1]}: {e}")

    if not re.match(r"^\d{4}-\d{2}-\d{2}$", DATE_KEY):
        die(f"invalid BRIEF_DATE_KEY {DATE_KEY!r} — must be YYYY-MM-DD (no test suffixes)")

    if not isinstance(brief, dict) or not brief.get("sections"):
        die("brief JSON must be an object with a non-empty 'sections' array")

    hero = brief.get("hero")
    if not isinstance(hero, dict) or not str(hero.get("title", "")).strip():
        die("brief JSON must include hero.title")

    result = call("POST", "brief", {"date": DATE_KEY, "brief": brief})
    if not result.get("ok"):
        die(f"write reported success but no row exists for {DATE_KEY}")

    print(f"SUCCESS: saved brief for {result['date']} ({result['bytes']} bytes)")


if __name__ == "__main__":
    main()
