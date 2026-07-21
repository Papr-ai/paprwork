#!/usr/bin/env python3
"""Normalize Papr workspace entity markdown files into the Memory Wiki contract.

This is intentionally conservative: it preserves existing frontmatter/body content,
adds missing quality metadata, maps common legacy sections into the required six
sections, and writes backups before changing files.
"""
from __future__ import annotations

import re
import shutil
from datetime import date
from pathlib import Path

ROOT = Path.home() / "Papr/workspace/entities"
TODAY = date.today().isoformat()
REQUIRED = [
    "Context & Background",
    "Key Details",
    "Key Interactions",
    "Decisions & Insights",
    "Open Items",
    "Changelog",
]
ALIASES = {
    "Context & Background": ["Why These Things Are Connected", "Overview", "Background", "Current Status"],
    "Key Details": ["Key Details", "Current Status", "Details"],
    "Key Interactions": ["Key Interactions", "Recent Activity", "Activity", "Timeline"],
    "Decisions & Insights": ["Decisions & Insights", "Key Decisions", "Decisions", "Insights"],
    "Open Items": ["Open Items", "Next Steps", "TODO", "Todos"],
    "Changelog": ["Changelog", "History", "Changes"],
}


def split_frontmatter(text: str) -> tuple[str, str]:
    if text.startswith("---\n"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            return parts[1].strip("\n"), parts[2].lstrip("\n")
    return "", text


def front_value(fm: str, key: str, default: str = "") -> str:
    m = re.search(rf"^{re.escape(key)}:\s*(.+)$", fm, re.M)
    if not m:
        return default
    return m.group(1).strip().strip('"')


def ensure_scalar(fm: str, key: str, value: str) -> str:
    if re.search(rf"^{re.escape(key)}:", fm, re.M):
        return fm
    return fm.rstrip() + f"\n{key}: {value}\n"


def block_exists(fm: str, key: str) -> bool:
    return bool(re.search(rf"^{re.escape(key)}:\s*(\n|$|\[)", fm, re.M))


def count_block_items(fm: str, key: str) -> int:
    m = re.search(rf"^{re.escape(key)}:\s*\n(?P<body>(?:^[ \t]+.*\n?)*)", fm, re.M)
    if not m:
        return 0
    return len(re.findall(r"^\s*-\s+", m.group("body"), re.M))


def extract_sections(body: str) -> tuple[str, dict[str, str]]:
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", body, re.M))
    if not matches:
        return body.strip(), {}
    intro = body[: matches[0].start()].strip()
    sections: dict[str, str] = {}
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        sections[m.group(1).strip()] = body[start:end].strip()
    return intro, sections


def find_section(sections: dict[str, str], canonical: str) -> str:
    for alias in ALIASES[canonical]:
        for name, content in sections.items():
            if name.lower().strip() == alias.lower().strip() and content.strip():
                return content.strip()
    return ""


def bulletize(text: str) -> str:
    if not text.strip():
        return ""
    lines = [ln.rstrip() for ln in text.strip().splitlines() if ln.strip()]
    if any(ln.lstrip().startswith("-") for ln in lines):
        return "\n".join(lines)
    return "\n".join(f"- {ln}" for ln in lines)


def build_required_sections(fm: str, intro: str, sections: dict[str, str], rel_count: int, ev_count: int) -> str:
    name = front_value(fm, "name", "Entity")
    typ = front_value(fm, "type", "entity")
    desc = front_value(fm, "description_short", front_value(fm, "description", "")).rstrip(".")
    status = front_value(fm, "status", "active")
    created = front_value(fm, "created", "unknown")
    updated = front_value(fm, "updated", TODAY)

    normalized: dict[str, str] = {}
    normalized["Context & Background"] = find_section(sections, "Context & Background") or intro.replace(f"# {name}", "").strip()
    if not normalized["Context & Background"]:
        normalized["Context & Background"] = f"{name} is a {typ} entity in the user's Papr workspace. {desc or 'It is tracked because it has recurring relevance to the user’s work.'}."
    elif desc and desc.lower() not in normalized["Context & Background"].lower():
        normalized["Context & Background"] += f"\n\n{desc}."

    details = find_section(sections, "Key Details")
    detail_lines = []
    if details:
        detail_lines.append(bulletize(details))
    detail_lines.extend([
        f"- Type: `{typ}`",
        f"- Status: `{status}`",
        f"- Created: `{created}`; updated: `{updated}`",
        f"- Evidence items: {ev_count}",
        f"- Relationships: {rel_count}",
    ])
    normalized["Key Details"] = "\n".join(detail_lines)

    interactions = find_section(sections, "Key Interactions")
    normalized["Key Interactions"] = bulletize(interactions) if interactions else f"- {updated} — Entity reviewed during wiki backfill; no additional dated interactions were captured in the source file."

    decisions = find_section(sections, "Decisions & Insights")
    normalized["Decisions & Insights"] = bulletize(decisions) if decisions else "- No durable decisions or insights have been captured yet."

    open_items = find_section(sections, "Open Items")
    if open_items:
        lines = []
        for ln in open_items.splitlines():
            stripped = ln.strip()
            if not stripped:
                continue
            if stripped.startswith("- ["):
                lines.append(stripped)
            elif stripped.startswith("- "):
                lines.append(f"- [ ] {stripped[2:].strip()}")
            else:
                lines.append(f"- [ ] {stripped.lstrip('- ').strip()}")
        normalized["Open Items"] = "\n".join(lines)
    else:
        normalized["Open Items"] = "No open items captured yet."

    changelog = find_section(sections, "Changelog")
    backfill_line = f"- {TODAY}: Normalized entity page to the Memory wiki quality contract."
    if changelog:
        normalized["Changelog"] = changelog if backfill_line in changelog else f"{backfill_line}\n{changelog}"
    else:
        normalized["Changelog"] = backfill_line

    # Preserve non-required sections under Key Details as source notes.
    used = {a.lower() for aliases in ALIASES.values() for a in aliases}
    extras = {k: v for k, v in sections.items() if k.lower() not in used and v.strip()}
    if extras:
        normalized["Key Details"] += "\n\nAdditional source notes:\n" + "\n".join(f"- {k}: {v.splitlines()[0][:160]}" for k, v in extras.items())

    return "\n\n".join(f"## {heading}\n{normalized[heading].strip()}" for heading in REQUIRED)


def normalize_file(path: Path) -> bool:
    original = path.read_text(errors="ignore")
    fm, body = split_frontmatter(original)
    name = front_value(fm, "name", path.stem.replace("-", " ").title())
    typ = front_value(fm, "type", path.parent.name.rstrip("s"))

    if not fm:
        fm = f"type: {typ}\nid: {path.stem}\nname: {name}\n"
    fm = ensure_scalar(fm, "type", typ)
    fm = ensure_scalar(fm, "id", path.stem)
    fm = ensure_scalar(fm, "name", f'"{name}"')
    fm = ensure_scalar(fm, "status", "active")
    fm = ensure_scalar(fm, "created", TODAY)
    fm = ensure_scalar(fm, "updated", TODAY)
    fm = ensure_scalar(fm, "confidence", "0.75")
    if not front_value(fm, "description_short"):
        desc = front_value(fm, "description", f"{name} is tracked in the Memory wiki.")
        fm = ensure_scalar(fm, "description_short", f'"{desc[:180].replace(chr(34), chr(39))}"')
    if not block_exists(fm, "tags"):
        fm = fm.rstrip() + "\ntags: []\n"
    if not block_exists(fm, "relationships"):
        fm = fm.rstrip() + "\nrelationships: []\n"
    if not block_exists(fm, "evidence"):
        fm = fm.rstrip() + f"\nevidence:\n  - date: {TODAY}\n    source: entity_backfill\n    summary: \"Entity normalized from existing workspace file.\"\n"

    rel_count = count_block_items(fm, "relationships")
    ev_count = count_block_items(fm, "evidence")
    intro, sections = extract_sections(body)
    section_count = sum(1 for r in REQUIRED if find_section(sections, r))
    complete = section_count == len(REQUIRED)
    score = 0.55 + min(section_count, 6) * 0.05 + min(ev_count, 3) * 0.04 + min(rel_count, 3) * 0.03
    score = min(score, 0.95)

    # Replace existing quality block if present, then append fresh quality block.
    fm = re.sub(r"^quality:\s*\n(?:^[ \t]+.*\n?)*", "", fm, flags=re.M)
    fm = fm.rstrip() + f"\nquality:\n  score: {score:.2f}\n  sections_complete: true\n  evidence_count: {ev_count}\n  relationship_count: {rel_count}\n  last_reviewed: {TODAY}\n"

    new_body = f"# {name}\n\n" + build_required_sections(fm, intro, sections, rel_count, ev_count) + "\n"
    new_text = f"---\n{fm.strip()}\n---\n\n{new_body}"
    if new_text != original:
        backup = path.with_suffix(path.suffix + f".backup.{TODAY.replace('-', '')}")
        if not backup.exists():
            shutil.copy2(path, backup)
        path.write_text(new_text)
        return True
    return False


def main() -> None:
    files = sorted(p for p in ROOT.glob("*/*.md") if ".backup." not in p.name)
    changed = 0
    for path in files:
        if normalize_file(path):
            changed += 1
            print(f"updated {path.relative_to(ROOT)}")
    print(f"checked={len(files)} changed={changed}")


if __name__ == "__main__":
    main()
