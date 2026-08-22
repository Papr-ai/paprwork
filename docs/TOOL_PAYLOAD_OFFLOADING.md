# Tool Payload Offloading

**Added:** 2026-08-21

Fixes the gateway running out of memory when opening a chat with heavy tool use.

---

## The problem

Every assistant turn wrote its tool payloads to SQLite **twice**:

- `messages.tool_calls` — canonical: LLM context, analytics, Papr sync
- `messages.sequence` — UI ordering, carrying its own copy of the same `input`/`output`

Combined with results that are not truncated on disk (file reads, scrapes,
delegation transcripts), single rows reached **100 MB+**. Opening such a chat
parsed every copy into the V8 heap, hit the ~4 GB ceiling, and aborted the
gateway process. On one real database, the 150 largest messages held **1.96 GB**
— about 64% of a 3.0 GB file.

Three things were wrong at once:

1. **Duplication** — the same bytes stored twice.
2. **Unbounded rows** — no cap on what a single row could hold.
3. **Eager parsing** — `loadMessages` parsed both columns for every row, even
   rows nothing was about to render.

---

## The fix

### 1. Store each payload once

`tool_calls` stays canonical. `sequence` keeps its ordering metadata and
replaces the duplicated values with pointers:

```jsonc
// stored
{ "type": "tool", "data": { "toolCallId": "tc-1", "inputRef": "toolCall", "outputRef": "toolCall:string" } }

// returned by loadMessages, after restoreSequencePayloads()
{ "type": "tool", "data": { "toolCallId": "tc-1", "input": { "command": "ls" }, "output": "…" } }
```

`outputRef` records the shape to rebuild (`toolCall:string` vs `toolCall:json`)
since `tool_calls` stores the stringified form. A JSON `null` output stays
inline — it serializes to nothing in `tool_calls`, so a pointer could not
restore it.

### 2. Move large payloads out of the row

A result over **256 KB** is written to a sidecar file and the row keeps a
**40 K preview** plus a pointer:

```
~/.paprwork-v2/tool-results/<chatId>/<messageId>/<toolCallId>.txt
```

```jsonc
{
  "id": "tc-1",
  "result": "first 40000 chars…\n\n[... 1,167,552 more characters stored outside the database (total 1,207,552). Full result: get_full_tool_result({ toolCallId: \"tc-1\" })]",
  "resultOffload": { "file": "tool-results/c1/m1/tc-1.txt", "totalChars": 1207552 }
}
```

**Nothing is discarded.** `get_full_tool_result` follows the pointer and reads
the sidecar, so the agent still has the complete text.

#### Why the preview is 40 K

`OFFLOAD_PREVIEW_CHARS` is sized to the default `absoluteMaxChars` (40,000) from
Settings → Agent Context. Every category limit in `historyFormatter` sits at or
below that ceiling, so the formatter truncates from the preview exactly as it
would have from the full result: **offloading cannot take away context the model
would otherwise have received.**

Two configurations reach past it, and both fall back to the pointer:

- `absoluteMaxChars` raised above 40,000
- `disableAllTruncation` enabled

In those cases a result over the offload threshold arrives as the preview plus
the notice, and the agent recovers the rest with `get_full_tool_result` (a
full-retention tool, so the fetched text is not re-truncated).

Cost of the larger preview, measured on the 150 largest messages of a real
3.0 GB database: **53.5 MB instead of 44.4 MB** — about 9 MB to keep the default
model ceiling fully inline.

#### Row budget

Because many medium results can add up, the whole `tool_calls` column also has
a **1 MB budget**, enforced in two passes:

1. Spill the largest still-inline results to sidecars (40 K preview each).
2. If previews alone still exceed the budget — dozens of huge results in one
   turn — re-cut the largest previews to `COMPACT_PREVIEW_CHARS` (4 K), largest
   first, until the row fits. The full payload is already on disk, so this only
   trades inline fidelity for a bounded row.

Sidecars are deleted with their chat.

### 3. Never parse a row large enough to be dangerous

Reads cap what they will pull into the heap at **2 MB per column**
(`MAX_INLINE_PAYLOAD_BYTES`). Anything larger returns `NULL` from SQL rather
than being selected and parsed:

```ts
boundedPayloadSql("tool_calls")
// CASE WHEN LENGTH(tool_calls) > 2097152 THEN NULL ELSE tool_calls END AS tool_calls
```

Applied in `loadMessages`, `loadMessagesForLLM`, `patchDelegateTaskToolResult`,
the context-footprint queries, and memory-search savings. This alone stops the
crash, including on databases that have not been compacted yet.

---

## Backfill for existing databases

`startToolPayloadMigration()` runs automatically 5 seconds after the gateway
opens the database, in chunks of 50 messages with the event loop yielding
between chunks. Nothing blocks startup.

Every rewrite happens **inside SQLite** via `json_set` / `json_remove`, so a
100 MB column is never parsed in JS. Only one result at a time crosses into
JS, on its way to its sidecar file.

The work is idempotent and resumable — a `tool_payload_migrated` flag with a
partial index marks each message once handled, so an interrupted run resumes
where it stopped. A malformed row is logged, left byte-identical, and flagged
so it cannot stall the backfill.

SQLite does not return freed pages to the filesystem on its own. Run `VACUUM`
once the backfill finishes to shrink the file.

---

## Results on a real 3.0 GB database

Verified with `scripts/verify-payload-migration-on-real-db.mjs`, which copies
the largest messages into a scratch database, migrates the copy, and compares
every payload back against the untouched original.

| Sample | Rows in DB before | After | Sidecars | Checks |
|---|---|---|---|---|
| 150 largest messages | 1,958 MB | **53.5 MB** (−97.3%) | 930 MB | 12,321 passed, 0 failed |

The difference between the original size and (rows + sidecars) is the
duplication that is now gone — roughly 975 MB across those 150 rows.

---

## Files

**Added**
- `src/gateway/services/storage/messagePayloadStore.ts` — serialize/restore, offload, sidecar I/O
- `src/gateway/services/storage/toolPayloadMigration.ts` — backfill scheduling and progress
- `src/gateway/services/storage/toolPayloadRowRewrite.ts` — the per-row SQL surgery
- `tests/message-payload-store.test.ts` — round-trip and offload unit tests
- `scripts/test-tool-payload-migration.mjs` — backfill tests (Electron)
- `scripts/verify-payload-migration-on-real-db.mjs` — losslessness check against a real DB

**Changed**
- `LocalStorageProvider.ts` — serialize on write, restore + size-guard on read, sidecar cleanup on delete, starts the backfill
- `HybridStorageProvider.ts` — passes through `readOffloadedToolResult`
- `IStorageProvider.ts` — `resultOffload` field, optional `readOffloadedToolResult`
- `toolResultLookup.ts`, `core/tools/chatHistory.ts` — `get_full_tool_result` follows pointers
- `contextFootprint.ts` — untruncated size uses `resultOffload.totalChars`, not the preview
- `contextFootprintSql.ts`, `contextFootprintStore.ts`, `memorySearchSavings.ts` — bounded reads

---

## Testing

```bash
npx vitest run tests/message-payload-store.test.ts --project unit-backend   # 13 tests
npm run test:payload-migration                                              # 26 tests (Electron)

# Optional: prove losslessness against your own database (read-only)
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
  scripts/verify-payload-migration-on-real-db.mjs --rows=25
```

SQLite-backed tests run under Electron because `better-sqlite3` is compiled for
Electron's runtime and cannot be loaded by plain Node (`ERR_DLOPEN_FAILED`).

---

## Notes and limits

- **Rows still oversized before the backfill reaches them** return no
  `toolCalls`/`sequence` and log a placeholder. The turn stays visible; tool
  detail returns once compacted. This replaces a crash.
- **The chat UI does not render successful tool output at all**
  (`getToolResultFeedback` returns `null` for `success`), so preview length is
  invisible there. `FileWritePreview` renders from `args`, not `result`, with one
  exception: `bash` needs a `__GIT_CHANGES__:` marker inside `result`, and those
  payloads are far below the offload threshold.
- **Error and warning rows** do read `result` to pull out a detail line. An
  error payload over 256 KB would no longer `JSON.parse`, so the detail falls
  back to the separate `toolCall.error` field. Error payloads that large are not
  something we have observed.
- **Chat export** truncates tool results to 500 chars anyway, well below the
  preview, so exports are unaffected.
- **Papr sync** receives the full in-memory message on first sync, before
  SQLite slimming, so cloud fidelity is unchanged.

---

## Prevention

1. Cap what a single row may hold; do not let payload size grow unbounded.
2. Store a payload once and point at it, rather than copying it per consumer.
3. Guard every read that parses a payload column with a size limit.
4. Select named columns — `SELECT *` can pull a 100 MB column into the heap
   just to discard it.
5. Do bulk JSON rewrites inside SQLite when the values are too large for JS.
