#!/usr/bin/env python3
"""
verify_quotes.py — prove that quoted evidence exists in its cited source.

Used by the Sleep Cycle and Wiki Writer agents so every claim in a daily log or
entity page carries a quote that is an *exact substring* of a real file. Same
idea as the Reddit Insight Extractor's `instr(body, ?) > 0` check, applied to
chat exports, daily logs, documents, and job logs.

Usage (batch — one call per log/page, not one per quote):

    python3 "$PAPR_HOME/workspace/verify_quotes.py" claims.json

claims.json is a list of objects:
    [{"id": "u1", "quote": "goals stay in IDENTITY.md", "source": "Chats/Home App Brief Alignment Audit.txt"}, ...]

`source` is resolved relative to $PAPR_HOME (or absolute). Wildcards allowed
(e.g. "Chats/*.txt") — the quote must appear in at least one match.

Output: JSON lines, one per claim:
    {"id": "u1", "ok": true,  "source": "Chats/Home App Brief Alignment Audit.txt", "line": 412}
    {"id": "u2", "ok": false, "reason": "quote not found", "closest": "goals stay in IDENTITY.md (already injected"}

Exit code 0 when every claim passes, 1 otherwise. Matching is whitespace- and
quote-style-insensitive (curly ↔ straight, runs of whitespace collapsed) but
otherwise exact — no fuzzy matching, so a quote either exists or it does not.
"""
from __future__ import annotations

import difflib
import glob
import json
import os
import re
import sys

PAPR_HOME = os.environ.get("PAPR_HOME") or os.path.expanduser("~/Papr")

_QUOTE_MAP = str.maketrans({
    "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
    "\u2013": "-", "\u2014": "-", "\u00a0": " ",
})


def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s.translate(_QUOTE_MAP)).strip().lower()


def resolve(source: str) -> list[str]:
    pattern = source if os.path.isabs(source) else os.path.join(PAPR_HOME, source)
    pattern = os.path.expanduser(pattern)
    hits = sorted(glob.glob(pattern))
    return hits if hits else ([pattern] if os.path.exists(pattern) else [])


def find_in_file(path: str, needle: str, want_hint: bool = True) -> tuple[bool, int | None, str | None]:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return False, None, None
    norm_text = normalize(text)
    if needle in norm_text:
        # Best-effort line number: first line whose normalized form overlaps the needle start.
        head = needle[: min(len(needle), 40)]
        for i, line in enumerate(text.splitlines(), 1):
            if head in normalize(line):
                return True, i, None
        return True, None, None
    if not want_hint:
        return False, None, None
    # Closest fragment for the agent to shorten toward.
    words = norm_text.split(" ")
    window = max(8, min(len(needle.split(" ")) + 4, 40))
    best, best_ratio = None, 0.0
    step = max(1, window // 2)
    for i in range(0, max(1, len(words) - window), step):
        frag = " ".join(words[i : i + window])
        r = difflib.SequenceMatcher(None, needle, frag).ratio()
        if r > best_ratio:
            best, best_ratio = frag, r
    return False, None, (best if best_ratio >= 0.5 else None)


def check(claim: dict) -> dict:
    cid = claim.get("id") or "?"
    quote = str(claim.get("quote") or "")
    source = str(claim.get("source") or "")
    if len(quote.strip()) < 12:
        return {"id": cid, "ok": False, "reason": "quote too short (min 12 chars) — pick a distinctive clause"}
    if not source:
        return {"id": cid, "ok": False, "reason": "missing source"}
    files = resolve(source)
    if not files:
        return {"id": cid, "ok": False, "reason": f"source not found: {source}"}
    needle = normalize(quote)
    closest = None
    # Only compute the (expensive) closest-fragment hint for single-file sources;
    # wildcard sources can span hundreds of files and the hint is rarely useful there.
    want_hint = len(files) == 1
    for path in files:
        ok, line, near = find_in_file(path, needle, want_hint)
        if ok:
            rel = os.path.relpath(path, PAPR_HOME) if path.startswith(PAPR_HOME) else path
            out = {"id": cid, "ok": True, "source": rel}
            if line:
                out["line"] = line
            return out
        closest = closest or near
    out = {"id": cid, "ok": False, "reason": "quote not found in source"}
    if closest:
        out["closest"] = closest
    return out


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    try:
        with open(argv[1], "r", encoding="utf-8") as fh:
            claims = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "reason": f"cannot read claims: {exc}"}))
        return 2
    if not isinstance(claims, list):
        print(json.dumps({"ok": False, "reason": "claims.json must be a list"}))
        return 2
    all_ok = True
    for claim in claims:
        result = check(claim if isinstance(claim, dict) else {})
        all_ok = all_ok and bool(result.get("ok"))
        print(json.dumps(result, ensure_ascii=False))
    print(json.dumps({"summary": True, "total": len(claims), "all_ok": all_ok}), file=sys.stderr)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
