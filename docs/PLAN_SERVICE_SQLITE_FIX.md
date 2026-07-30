# Plan Service SQLite Fix

**Date:** 2026-02-17  
**Issue:** `create_plan` tool failed with `SQLITE_ERROR` when agent tried to create plans

## Problem

The PlanService initialization was failing with a SQLite error:
```
[AgentService] Tool error (create_plan): { code: 'SQLITE_ERROR' }
```

### Root Cause

The table schema had an **invalid foreign key constraint**:

```sql
CREATE TABLE plans (
  ...
  chat_id TEXT NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE  -- ❌ INVALID
);
```

This constraint is invalid because:
1. Plans are stored in `$PAPR_HOME/data/plans.db`
2. Chats are stored in a separate location (`~/.paprwork-v2/chats/` for local storage)
3. **SQLite doesn't support foreign keys across different database files**

When the agent tried to insert a plan, SQLite tried to validate the foreign key but couldn't find the `chats` table, causing the error.

## Solution

Removed the foreign key constraint from the schema:

```sql
CREATE TABLE plans (
  plan_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,         -- ✅ Still stores chat_id for reference
  title TEXT NOT NULL,
  steps TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
  -- No FOREIGN KEY constraint
);
```

The `chat_id` field is still present for querying plans by chat, but without the constraint that requires the chats table to exist.

## Migration

Since the existing database has the invalid schema, it needs to be deleted and recreated:

```bash
rm $PAPR_HOME/data/plans.db
```

The PlanService will automatically recreate it with the correct schema on next startup.

## Why This Works

1. **Application-level referential integrity:** The PlanService APIs validate chat_id exists when needed
2. **No cascading deletes:** Plans should persist even if a chat is deleted (they're historical records)
3. **Separate storage:** Plans and chats can evolve independently
4. **Better performance:** No foreign key validation overhead on inserts

## Files Changed

- `src/gateway/services/PlanService.ts` (line 65 - removed FOREIGN KEY constraint)

## Testing

To verify the fix works:

1. Delete old database: `rm $PAPR_HOME/data/plans.db`
2. Restart the app: `npm start`
3. Ask agent to build an app: "Build me a task tracker app"
4. Verify plan is created successfully with visible progress cards in UI
5. Check database exists: `ls -la $PAPR_HOME/data/plans.db`

## Lessons Learned

1. **Avoid cross-database foreign keys:** SQLite doesn't support them - use application-level validation instead
2. **Test tool failures:** When tools fail silently, the agent won't report helpful errors
3. **Schema design:** Consider where data lives before adding constraints
4. **Database migrations:** When schema changes require breaking changes, provide migration path

## Related Issues

- Foreign keys only work within a single SQLite database file
- SQLite doesn't support `ATTACH DATABASE` for foreign key constraints
- This is a common SQLite gotcha when splitting data across multiple databases
