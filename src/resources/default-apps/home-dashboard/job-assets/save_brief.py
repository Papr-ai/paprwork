#!/usr/bin/env python3
"""Save the Home dashboard daily brief.

Usage:
    python3 save_brief.py <brief.json>
    BRIEF_DATE_KEY=2026-08-31 python3 save_brief.py <brief.json>

Why this script exists
----------------------
The briefs database is Turso replica-synced. Writing it with a direct
sqlite3 connection races the sync layer and the row can be silently
discarded. All writes MUST go through the gateway (/api/db/write) so they
land in the same backend the dashboard reads.

Two failure modes this guards against, both of which previously caused the
dashboard to silently go stale for days:

1. /api/db/* returns errors with HTTP 200 and an {"error": ...} body.
   Checking only res.ok / catching exceptions is NOT enough.
2. The data-source `id` is not the same as its `alias`. Hardcoding either
   one breaks when the job id or alias changes. We resolve the real source
   from the app's data-sources.json at runtime instead.

Exits non-zero on any failure. Never reports success without re-reading
the row back through the query endpoint.
"""
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request

APP_ID = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c"
GATEWAY = os.environ.get("PAPR_GATEWAY", "http://localhost:18789")
DATE_KEY = os.environ.get("BRIEF_DATE_KEY") or datetime.date.today().isoformat()
TABLE = "briefs"


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def resolve_source_id():
    """Find the data source that owns the briefs table.

    Prefers the explicit `id` field, falling back to `alias`. Returning None
    is fine: the gateway resolves an omitted sourceId when the app has
    exactly one linked source.
    """
    papr_home = os.environ.get("PAPR_HOME")
    if not papr_home:
        return None
    ds_path = os.path.join(papr_home, "apps", APP_ID, "data-sources.json")
    try:
        with open(ds_path) as f:
            raw = json.load(f)
    except Exception:
        return None

    sources = raw.get("sources", raw) if isinstance(raw, dict) else raw
    if not isinstance(sources, list):
        return None

    for src in sources:
        if not isinstance(src, dict):
            continue
        if TABLE in (src.get("tables") or []):
            return (src.get("id") or "").strip() or (src.get("alias") or "").strip() or None
    return None


SOURCE_ID = resolve_source_id()


def call(endpoint, sql, params):
    body = {"appId": APP_ID, "sql": sql, "params": params}
    if SOURCE_ID:
        body["sourceId"] = SOURCE_ID
    req = urllib.request.Request(
        f"{GATEWAY}/api/db/{endpoint}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            parsed = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        die(f"gateway HTTP {e.code} on /{endpoint}: {e.read()[:400]!r}")
    except Exception as e:
        die(f"gateway request to /{endpoint} failed: {e}")

    # Errors come back with HTTP 200 — this check is the important one.
    if isinstance(parsed, dict) and parsed.get("error"):
        die(f"gateway returned error on /{endpoint}: {parsed['error']}")
    return parsed


def print_reviews(days=30):
    """--reviews: dump the user's check/x feedback on past brief items as JSON.

    Read by the brief prompt before ranking so dismissed items (and their
    siblings under the note's rule) are never resurfaced. Goes through the
    same gateway path as the save, so it resolves the right sourceId.
    """
    try:
        result = call(
            "query",
            "SELECT brief_date, section, item_type, title, status, note, updated_at "
            "FROM brief_reviews WHERE updated_at >= datetime('now', ?) "
            "ORDER BY updated_at DESC",
            [f"-{int(days)} days"],
        )
    except SystemExit:
        # Pre-migration install: table missing. No feedback yet is a valid state.
        print("[]")
        return
    rows = result.get("rows") or []
    print(json.dumps(rows, ensure_ascii=False, indent=2))


def print_tasks():
    """--tasks: open tasks (L3 goals + entity Open Items) with their goal chain.

    Projected by the gateway from IDENTITY.md and entity pages; this is the
    candidate pool for today's priorities. Each row carries `id` — put it on
    the brief item as `task_id` so a check in Home completes the task.
    """
    try:
        result = call(
            "query",
            "SELECT t.id, t.title, t.owner, t.due, t.goal_id, t.entity_ref, t.source, "
            "g.title AS goal_title, g.level AS goal_level, g.parent_id AS goal_parent, "
            "g.status AS goal_status, g.confidence AS goal_confidence, g.priority AS goal_priority "
            "FROM tasks t LEFT JOIN goals g ON g.id = t.goal_id "
            "WHERE t.status = 'open' "
            "ORDER BY CASE WHEN t.due IS NULL THEN 1 ELSE 0 END, t.due, COALESCE(g.priority, 99), t.title",
            [],
        )
    except SystemExit:
        print("[]")
        return
    print(json.dumps(result.get("rows") or [], ensure_ascii=False, indent=2))


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--tasks":
        print_tasks()
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "--reviews":
        days = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 30
        print_reviews(days)
        return

    if len(sys.argv) < 2:
        die("usage: save_brief.py <brief.json> | save_brief.py --reviews [days] | save_brief.py --tasks")

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

    call(
        "write",
        f"INSERT OR REPLACE INTO {TABLE} (date, brief_json, created_at) "
        "VALUES (?, ?, datetime('now'))",
        [DATE_KEY, json.dumps(brief)],
    )

    result = call(
        "query",
        f"SELECT date, length(brief_json) AS len FROM {TABLE} WHERE date = ?",
        [DATE_KEY],
    )
    rows = result.get("rows") or []
    if not rows:
        die(f"write reported success but no row exists for {DATE_KEY}")

    print(f"SUCCESS: saved brief for {rows[0]['date']} ({rows[0]['len']} bytes)")


if __name__ == "__main__":
    main()
