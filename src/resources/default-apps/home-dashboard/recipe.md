## Intent

Generate a daily brief JSON row in the Home app's linked SQLite database (`$APP_DB`) so the bundled Home dashboard displays today's priorities, schedule, and alerts.

## Success Criteria

- A row exists in `briefs` for today's UTC date (`YYYY-MM-DD`).
- `brief_json` parses as JSON and includes `hero` and at least one `sections` entry.
- The write used `$APP_DB` via bash/sqlite3 — not `$JOB_DB`, a hardcoded path, or `/tmp` script.
- Step 5 verification query returned a row before the run finished.

## Quality Rubric

| Criterion | Weight |
|-----------|--------|
| Today's brief row saved to `$APP_DB` | 0.35 |
| Valid JSON structure (hero + sections) | 0.25 |
| Uses real workspace context (jobs, memory, calendar when available) | 0.20 |
| Concise, scannable content (not dashboard soup) | 0.10 |
| No fabricated metrics when data unavailable | 0.10 |

## Anti-Patterns

- Writing to `$JOB_DB` for the `briefs` table (app-linked jobs must use `$APP_DB`).
- Hardcoded `$PAPR_HOME/Jobs/{wrong-id}/...` paths or `/tmp` scripts without job env vars.
- Reporting success without running the verification SELECT.
- Empty or sample-only brief when workspace data exists.
- Duplicate brief rows for the same date (must UPSERT).

## Edge Cases

- No calendar or CRM jobs linked → still produce hero + priorities from memory/workspace notes.
- Cloud scheduler run → `$APP_DB` must resolve to the Home app's linked database for this workspace.
- Re-run same day → UPDATE/REPLACE existing row, do not fail on duplicate key.

## Expected Output

One verified SQLite row:

```sql
SELECT date, length(brief_json) FROM briefs WHERE date='YYYY-MM-DD';
```

Returns one row with `length(brief_json) > 100`.
