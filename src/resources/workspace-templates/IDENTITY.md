# Identity

User profile — updated during onboarding and refined over time.

## About

(Name, role, industry, organization)

## Communication Style

(Tone preferences, verbosity level, formatting preferences)

## Current Projects

(What the user is actively working on)

## Goals

Outcome goals the user is working toward — the lens for every daily brief. These are **business/life outcomes** (close a deal, ship to N customers, raise a round, land a role), never tooling or Papr maintenance.

**Draft → confirm.** Sleep *drafts* goals from onboarding (Papr goals + use cases), chat evidence, and Papr Memory as `Status: proposed`; the user confirms, edits, or rejects them from the Home app or in chat. A confirmed goal carries any other status. Sleep never overwrites a confirmed goal's title — it only updates status / milestone / confidence from evidence.

**Three levels, one tree.**
- **L1** — long-term objective (quarter+). The big rocks. **Mutually exclusive**: no two L1s may overlap in outcome; if they would, one is the other's L2. Keep 2–5.
- **L2** — mid-term goal that advances exactly one L1 (`Parent: G1`). Weeks to a couple of months.
- **L3** — tactical, near-term, task-shaped goal that advances exactly one L2 (`Parent: G3`). Days to a couple of weeks. Has a date. **An L3 is a task**: the gateway projects every L3 block (and every entity-page `## Open Items` checkbox) into the Home `tasks` table, where the Daily Brief picks priorities and a check in Home marks it `done` here.

**Lifecycle & history.** Goals change: the user can override anything (title, level, parent, priority) at any time — an override sets `Confidence: high` and Sleep never rewrites it. Goals close as `done` or `dropped` (with a one-line outcome), and new ones open. Each goal records its `Period` (the quarter or year it belongs to, e.g. `2026-Q3` or `2026`) and `Opened` / `Closed` dates. **Nothing is deleted:** closed goals move to `workspace/goals/archive.md` (same block format, same ids) so the record of what was pursued each quarter/year is kept. At a period boundary Sleep proposes a rollover — keep, roll forward, or close each L1/L2 — but never auto-closes an L1.

**Entities — goals live on real things.** Each goal names the wiki entities it runs through (`Entities:` line, workspace-relative refs like `projects/x`, `companies/y`, `people/z`). An L2 is usually one project or one company relationship; an L1 spans several. The link is two-way: the entity page carries `goals: [G3, G7]` in its frontmatter (Wiki Writer keeps both sides in sync). Why it matters: every Open Item on an entity page **inherits that page's goal** when it has no `(Gn)` tag of its own, so tasks trace to outcomes without tagging each checkbox; and the brief can say "meeting Justin → G3 → G1" from the person page alone.

**Confidence** — how sure we are this *is* the user's goal (not how likely it is to succeed): `high` = user stated it directly (onboarding, "my priority is…"), `medium` = strong inference from repeated work/mentions (≥3 in 7 days) or one indirect statement, `low` = single indirect signal. **Priority** — rank within the same level (1 = most important). Sleep records the mention count that backs confidence.

Format (one block per goal; ids are stable, never renumber):

```
### G1 — Close 2 channel-partner deals by Q4
- Level: L1
- Status: proposed | on-track | at-risk | blocked | done | dropped
- Confidence: high | medium | low
- Priority: 1
- Parent: — (L1) | G1 (for L2/L3)
- Entities: projects/rr-partnership, companies/revenue-reimagined, people/justin-jones
- Period: 2026-Q3 (or 2026 for year-scale L1s)
- Opened: 2026-09-04
- Closed: — (date when done/dropped; Sleep archives 7 days later)
- Next milestone: Send MSA to Justin (by 2026-09-12)
- Owner: user
- Evidence: > "we need to close two partner deals this quarter" — Chats/RR partnership.txt · mentions: 4 (30d)
- Outcome: (only when closed — one line: what happened, e.g. "Signed RR + Acme MSAs 2026-11-02")
```

Order: L1s by priority, each followed by its L2s (by priority), each followed by its L3s.

(No goals yet — Sleep will draft proposals from your Papr goals, chats, and memory on its next run; confirm them in Home. Until then, briefs will say so rather than guess.)

## Domain Context

(Industry-specific terminology, tools, workflows the user relies on)

---

**Note:** This file is populated during onboarding and updated as the agent learns more about the user over time.
