# Sync V3 Outbox Guardrails

**Added:** 2026-08-23
**Severity of the bug this fixes:** CRITICAL — gateway OOM on every launch

## The crash

The gateway died with a V8 heap OOM roughly 70 seconds after every start. The
allocation that killed it was a single string:

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

The file behind it was the Sync V3 writer outbox:

```
~/Papr/orgs/<org>/namespaces/<ns>/data/sync-outbox.jsonl   1.6 GB
```

869 entries, 868 of them still pending, and three individual lines of roughly
520 MB each. `SyncOutbox.readAllLines()` did this:

```ts
const raw = await fs.readFile(outboxPath(), "utf8"); // 1.6 GB as one JS string
```

`appSyncV3StatusReport` called into the outbox several times per app shortly
after startup, which is what put the read ~70 seconds in rather than at boot.

## Why the file grew that large

Four separate problems compounded:

1. **Entries carried file contents inline with no size cap.** A writer op stores
   the bytes of every file it touches. The Papr Data Room app keeps uploaded
   PDFs and images inside its app directory, so a single op could carry hundreds
   of megabytes.
2. **Binary files were encoded as UTF-8 JSON strings.** A JPEG read as `utf8`
   both bloats (invalid sequences become U+FFFD, 3 bytes each) and corrupts, so
   the blob was large *and* useless.
3. **A crash did not count as an attempt.** `markOutboxInflight` left `attempts`
   untouched, so an entry that killed the process was retried forever and never
   reached the dead-letter threshold.
4. **Nothing coalesced duplicate work.** Every debounced flush appended a fresh
   op for the same app and the same paths; none of the older pending ops were
   retired.

The result was head-of-line blocking with a poison pill at the front: the queue
could only grow, and reading it to find out what to do was itself the crash.

## The fix

Two layers. Guardrails so the gateway survives and drains whatever is already
queued, then exclusions so the offending bytes never enter the queue again.

### Layer 1 — Gateway guardrails

**Bounded reads** (`src/gateway/services/syncV3/outboxFile.ts`, new)

`streamJsonlLines` walks the file as bytes and only decodes a line once it is
complete *and* known to be under the cap. An oversized line is never turned into
a string: its bytes are handed to a callback as they arrive and dropped. Peak
memory is one stream chunk regardless of file size.

`readJsonlBounded` returns the lines under the cap plus a report of the oversized
ones. `compactJsonlDroppingOversized` rewrites the queue without them, streaming
their bytes into a `.oversized` sibling file so nothing is deleted.

Two limits:

| Constant | Value | Meaning |
|---|---|---|
| `MAX_OUTBOX_LINE_BYTES` | 16 MB | One queued op. Set well above the collector's 6 MB batch budget so JSON escaping cannot turn an acceptable batch into an unwritable line. |
| `MAX_OUTBOX_FILE_BYTES` | 64 MB | The whole queue. Above this, reading every entry to update one is too costly. |

**Cap at enqueue** (`SyncOutbox.ts`)

`appendOutboxEntry` rejects anything over `MAX_OUTBOX_LINE_BYTES` with
`OutboxEntryTooLargeError` rather than writing a line that can never be read
back. The message points at App Files, which is where large assets belong.

**A crash counts as an attempt** (`SyncOutbox.ts`)

`markOutboxInflight` now increments `attempts`. An entry that kills the process
is charged for it, so a poison pill reaches the dead-letter threshold instead of
blocking the queue forever.

**Dead-lettering strips payloads** (`SyncOutbox.ts`)

`markOutboxDeadLetter` drops `files[].content` and keeps
`droppedFileCount` + `droppedFilePaths`. A dead entry stays diagnosable without
holding megabytes on disk.

**Coalescing** (`SyncOutbox.ts`)

When a new op covers the same paths as older pending ops for the same app, those
older entries are marked superseded. Repeated debounced flushes now replace
rather than accumulate.

**File budget backstop** (`SyncOutbox.ts`)

If the queue still passes `MAX_OUTBOX_FILE_BYTES`, `trimToFileBudget` sheds the
oldest queued work. Dropped ops are recollectible — the collector rebuilds them
from the filesystem on the next flush — so this costs a re-scan, not data.

**One read per status report** (`appSyncV3StatusReport.ts`)

`listOutboxEntries` is called once and filtered for pending/inflight/dead-letter
instead of three separate reads per app.

The same bounded read replaced the unbounded one in `metadataOutbox.ts`.

### Layer 2 — Keep the bytes out

**Correct never-track matching** (`appRepoWriter/abuseFilter.ts`)

`matchesNeverTrackPathspec` matched by substring, so `*.db` excluded
`sandbox.ts` and `*.bak.*` excluded anything containing `bak`. Legitimate source
files were silently dropped from sync. `isNeverTrackRepoPath` replaces it with
anchored matching: extensions against the basename's suffix, directory specs
against path segments.

`*.db-journal` was added to `NEVER_TRACK_PATHSPECS` alongside `-wal` and `-shm`.

**Exclude before reading** (`syncV3/collectAppOpFiles.ts`)

The walkers now test `isNeverTrackRepoPath` while walking, so a 500 MB
`database.db` is skipped by name and never read into memory. `candidateToOpFile`
checks `stat.size` *before* `fs.readFile`, so an oversized file is rejected
rather than loaded and then discarded.

**Aggregate batch budget** (`syncV3/collectAppOpFiles.ts`)

Per-file limits do not bound a batch: a thousand 5 MB files still overflow.
`MAX_OP_BATCH_CONTENT_BYTES` (6 MB) caps the total content in one op. Files past
the budget are counted as `deferred` and picked up by the next flush.

`deferred` propagates through `PushAppViaWriterResult` and
`FinalizeAppRepoMutationResult` to `cloudAppWriterDebouncedPush`, which re-queues
any app that reported deferred files. A large app therefore syncs across several
flushes instead of in one op that cannot be written.

The OID cache is now read once per flush rather than once per file.

## Results

Verified against the real production outbox, reconstructed in an isolated
workspace (`tests/sync-outbox-recovery-fixture.test.ts`):

| | Before | After |
|---|---|---|
| Reading the queue | OOM, process dies | completes in 2.3 s |
| Peak heap growth | unbounded — a 1.5 GB string | 98 MB |
| Entries recovered | 0 (crash) | 303, all pending |
| Queue on disk | 1521 MB | 32 MB |
| Oversized bytes | blocking the queue | 1489 MB quarantined to `.oversized` |

Three lines accounted for the 1489 MB. The 303 entries behind them were
unreachable before this change and drain normally after it.

## Tests

| File | Covers |
|---|---|
| `tests/sync-outbox-guardrails.test.ts` | streaming reads, oversized detection, quarantining, enqueue cap, crash-counts-as-attempt, payload stripping, coalescing, recovery from a pre-existing oversized line |
| `tests/never-track-repo-path.test.ts` | anchored matching; `sandbox.ts` and friends are *not* excluded |
| `tests/collect-app-op-files.test.ts` | databases and `.bak` copies never read, oversized file skipped before read, batch budget defers the remainder |
| `tests/sync-outbox-recovery-fixture.test.ts` | full recovery against a reconstructed production outbox (skipped unless `OUTBOX_FIXTURE` is set) |

```bash
npx vitest run tests/sync-outbox-guardrails.test.ts \
  tests/never-track-repo-path.test.ts \
  tests/collect-app-op-files.test.ts --project unit-backend

# Against a real oversized outbox (paths joined by ':'):
OUTBOX_FIXTURE=/path/sync-outbox.jsonl.oversized:/path/sync-outbox.jsonl \
  npx vitest run tests/sync-outbox-recovery-fixture.test.ts --project unit-backend
```

## What app authors should do

Guardrails stop the crash; they do not make large assets sync. An app that keeps
uploads inside its own directory will see them rejected as over the limit. Store
them with App Files and keep the reference in SQLite. The Papr Data Room app is
the first case and adopts the files SDK next.

## Prevention

- Never `fs.readFile` a file whose size is controlled by user data. Stream it, or
  bound it, or check `stat.size` first.
- Cap a queue entry at enqueue. A line that cannot be read back is worse than a
  rejected write.
- Charge an attempt when work is picked up, not when it fails. A crash mid-push
  otherwise retries forever.
- Per-item limits do not bound a batch; add an aggregate budget and a way to
  defer the remainder.
- Anchor glob matching. Substring matching on `*.db` quietly drops `sandbox.ts`.
