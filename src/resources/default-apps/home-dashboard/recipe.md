## Intent

Act as the user's chief of staff: produce one daily brief row in the Home app's linked database that tells the user what to do today to move their **goals**, what they are **waiting on**, and what only they can **decide** — grounded in the daily log, entity commitments, and goals in `IDENTITY.md`. Papr's own plumbing (jobs, sync, app fixes) is not the user's work and must not fill the brief.

## Success Criteria

- A row exists in `briefs` for `$BRIEF_DATE_KEY` (or today's local date), saved via `python3 "$JOB_DIR/save_brief.py"` and confirmed by its `SUCCESS:` line.
- `brief_json` parses; includes `hero` and at least one evidence-backed section.
- Every `priorities` item names a goal id (`G1`, `G2`, …) that exists in `IDENTITY.md` → `## Goals`, and reads as a concrete action involving a person, artifact, or decision.
- No priority, alert, or hero stat is about Papr infrastructure: job runs/failures, sync, Turso, schema, scrapers, API keys, app polish, or agent tasks.
- When `IDENTITY.md` has no goals, the brief says so in `hero.subtitle` and does not rank open items as priorities.
- When a "Waiting On" or "Decisions Pending" section is present, each item cites a person and a date/age that exists in the daily log or an entity page.
- `save_brief.py --reviews` was run before ranking, and no item the user marked `complete` or `irrelevant` (nor a near-duplicate, nor anything covered by the generalised rule in an irrelevance note) appears in the brief.

## Quality Rubric

| Criterion | Weight |
|-----------|--------|
| Goal-traceable priorities: ≤3 items, each tied to a real goal id; zero Papr-infrastructure items anywhere except the Overnight line | 0.30 |
| Respects feedback: nothing the user marked complete/irrelevant in `brief_reviews` (or an obvious sibling under the rule in their note) is resurfaced | 0.15 |
| Actionability: each priority/waiting-on/decision names the person or artifact, the action, and why today (deadline, age, unblocks) | 0.15 |
| Grounded: every claim traces to the daily log, an entity page, or live data — no invented meetings, numbers, or commitments | 0.15 |
| Chief-of-staff coverage: uses Commitments (waiting on / owed) and Decisions Pending when evidence exists; honest "quiet day" when it does not | 0.10 |
| Saved correctly via `save_brief.py` with confirmed `SUCCESS:` line; valid JSON in the documented shape | 0.15 |

A brief scoring below the threshold is most often one whose priorities are chores — ranking "fix", "validate", "configure", or "deploy" tasks for the user's own tooling. Score those as failing on the first criterion regardless of how well they are saved.

## Anti-Patterns

- Priorities about Papr jobs, apps, sync, databases, schemas, scrapers, or API keys — including ones that mention a customer's name.
- Alerts about job failures, Sleep/Wiki status, or "days since last brief".
- Calling `list_jobs()` to decide what matters.
- Filling 3 priority slots when only one thing genuinely moves a goal.
- Inventing goals to satisfy the goal-id rule when `IDENTITY.md` has none.
- Ranking untagged, `[agent]`, `[papr]`, or `(no-goal)` open items as priorities.
- Resurfacing an item the user checked off or dismissed, or treating an irrelevance note as applying only to that one exact title.
- Skipping `save_brief.py --reviews` (or reading `brief_reviews` via sqlite3).
- Writing `briefs` via `sqlite3`, a hand-rolled `/api/db/write` call, or `$JOB_DB`; claiming success without the `SUCCESS:` line.

## Edge Cases

- **No goals recorded** → `hero.subtitle` asks the user for goals; include only Waiting On / Decisions Pending if evidenced; no priorities section.
- **No calendar / CRM** → omit `timeline`; never fabricate meetings.
- **Only system work in the daily log** → "Quiet day" hero; one Overnight sentence; no priorities padded from tooling.
- **Re-run same day** → `save_brief.py` upserts; do not fail on duplicate key.
- **Cloud scheduler run** → `save_brief.py` resolves the Home app data source for this workspace.

## Expected Output

One verified row confirmed by `save_brief.py`:

```
SUCCESS: saved brief for YYYY-MM-DD (<n> bytes)
```

with `brief_json` whose priorities (if any) each carry a goal id and none of whose sections describe Papr's own maintenance.
