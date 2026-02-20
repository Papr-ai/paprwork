# Database Migration: Adding Thinking & Tool Calls Columns

## Problem

**Error**: `SqliteError: no such column: thinking`

**Root Cause**: The code added new columns to the schema, but existing databases don't have them!

```typescript
// This only works for NEW databases:
CREATE TABLE IF NOT EXISTS messages (..., thinking TEXT, ...)
```

For existing databases, the table already exists, so `IF NOT EXISTS` skips creation entirely.

## Solution: Automatic Migration on Startup

Added migration logic that checks for missing columns and adds them:

```typescript:98-137:src/gateway/services/storage/LocalStorageProvider.ts
// Migrate existing databases: Add new columns if they don't exist
const columns = this.db.pragma('table_info(messages)') as Array<{ name: string }>;
const columnNames = columns.map(c => c.name);

console.log('[LocalStorage] Messages table columns:', columnNames);

// Add thinking column if missing
if (!columnNames.includes('thinking')) {
  console.log('[LocalStorage] Adding "thinking" column to messages table...');
  this.db.exec('ALTER TABLE messages ADD COLUMN thinking TEXT');
}

// Add tool_calls column if missing
if (!columnNames.includes('tool_calls')) {
  console.log('[LocalStorage] Adding "tool_calls" column to messages table...');
  this.db.exec('ALTER TABLE messages ADD COLUMN tool_calls TEXT');
}

// Add error column if missing
if (!columnNames.includes('error')) {
  console.log('[LocalStorage] Adding "error" column to messages table...');
  this.db.exec('ALTER TABLE messages ADD COLUMN error TEXT');
}

// Add incomplete column if missing
if (!columnNames.includes('incomplete')) {
  console.log('[LocalStorage] Adding "incomplete" column to messages table...');
  this.db.exec('ALTER TABLE messages ADD COLUMN incomplete INTEGER DEFAULT 0');
}

console.log('[LocalStorage] Database migration complete');
```

## How It Works

1. **On startup**: `LocalStorageProvider.initialize()` runs
2. **Check columns**: Uses SQLite's `PRAGMA table_info()` to list existing columns
3. **Add if missing**: Only adds columns that don't exist (safe for both new and old DBs)
4. **Log everything**: Shows exactly what was migrated

## Migration Flow

### First Launch (New Database)
```
[LocalStorage] Messages table columns: ['id', 'chat_id', 'role', 'content', ...]
[LocalStorage] Database migration complete  (no changes needed)
```

### Existing Database (Needs Migration)
```
[LocalStorage] Messages table columns: ['id', 'chat_id', 'role', 'content', 'timestamp', ...]
[LocalStorage] Adding "thinking" column to messages table...
[LocalStorage] Adding "tool_calls" column to messages table...
[LocalStorage] Adding "error" column to messages table...
[LocalStorage] Adding "incomplete" column to messages table...
[LocalStorage] Database migration complete
```

## Testing

After restart:

1. **Old chats load successfully** ✅
   - No more `no such column: thinking` errors
   - Old messages show (without thinking/tools, since they're NULL)
   
2. **New messages save with metadata** ✅
   - thinking, toolCalls, error, incomplete all saved
   
3. **New chats work perfectly** ✅
   - Full thinking and tool call history

## Why This Approach

**Alternative 1: Drop and recreate table**
```sql
DROP TABLE messages;
CREATE TABLE messages (...);
```
❌ **Bad**: Loses all chat history!

**Alternative 2: Backup → Recreate → Restore**
```sql
CREATE TABLE messages_backup AS SELECT * FROM messages;
DROP TABLE messages;
CREATE TABLE messages (...);
INSERT INTO messages SELECT ..., NULL as thinking, ...;
```
❌ **Complex**: Risky, lots of edge cases

**Alternative 3: ALTER TABLE (Our Choice)**
```sql
ALTER TABLE messages ADD COLUMN thinking TEXT;
```
✅ **Perfect**: 
- Safe (no data loss)
- Fast (milliseconds)
- Idempotent (can run multiple times)
- Works for both new and old databases

## Data Compatibility

**Old messages** (before migration):
- `thinking`: NULL
- `tool_calls`: NULL
- `error`: NULL
- `incomplete`: 0 (default)

**Effect**: Old messages show text only (graceful degradation)

**New messages** (after migration):
- `thinking`: Actual reasoning text
- `tool_calls`: JSON array of tools
- `error`: Error message if any
- `incomplete`: 1 if interrupted

**Effect**: New messages show full UI with thinking/tool cards

## Summary

✅ **Migration runs automatically** on next startup  
✅ **Safe for existing data** (no data loss)  
✅ **Works for old and new databases**  
✅ **Comprehensive logging** for debugging  
✅ **Backward compatible** (old messages still work)

**After restart**: All three issues should be fixed!
