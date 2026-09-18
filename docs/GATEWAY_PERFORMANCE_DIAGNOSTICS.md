# Gateway performance diagnostics

After rebuilding and restarting the gateway, inspect
`GET /api/debug/gateway-performance` on its existing local HTTP address.

**Timeline UI (Temporal-style):** open
In **dev**, open **Settings → Dev → Gateway performance → Open in browser** (or
paste the URL below). In a browser while
the gateway is running. It polls the JSON API every 3s, plots operation lanes
(queue vs run, parallel stacks), and lists slow event-loop sample windows with
**active at sample** vs **overlapping** operations.

The JSON payload includes a `timeline` object (`schemaVersion` 4) with
`slowEventLoopWindows` (windows where event-loop **max** ≥ 500ms) and stacked
`operations` for rendering.
`/api/debug/gateway-background` returns the same payload and preserves its old
fields. Diagnostics begin automatically with the existing event-loop monitor.
This does not change heap-snapshot policy or send diagnostic records to a server.

## Resource history

`resources.samples` retains 120 samples, normally five seconds apart (about ten
minutes). A blocked event loop delays a sample; `elapsedMs` records the actual
interval. Each sample contains:

- Event-loop mean, p95 and maximum delay in milliseconds, with sample count.
- Gateway process CPU as a percentage of one CPU core; multi-threaded work can
  exceed 100%. CPU of installer/worker child **processes** is not included.
- RSS, heap used/total, external memory and array-buffer memory, in bytes.
- System free/total memory and OS load averages (load averages are zero on Windows).
- Garbage-collection count, cumulative duration and longest observed duration.
- IDs of operations still active at sample time.

`resources.currentWindow` exposes the partial current event-loop window.
`resources.recentGc` retains 120 GC timestamps and durations. GC observer delivery
is asynchronous, so a GC may be counted in a later sampling window; its individual
timestamp still identifies when it occurred. Reading the endpoint or running a
WebSocket liveness check does not reset these windows.

## Operation traces

`operations.active` shows queued/running work. `operations.recent` contains recent
completed, failed and cancelled work, sorted by completion timestamp. Durations
use a monotonic clock; ISO timestamps support correlation with logs. `id` is the
operation ID. Child operations inherit `turnId` (the parent chat record's `id`),
`chatId` and provider/model metadata when available, including across asynchronous
tool execution. Separate simultaneous turns remain separate.

- **chat:** whole agent-service turn, including preparation and cleanup. `queueMs`
  accumulates concurrency-gate waits; it is zero for routes that bypass the gate.
  `firstResponseMs` measures time to the first meaningful content/tool chunk;
  `firstTextMs` measures time to first text. Both include preparation and queue
  time. `longestStreamGapMs` measures gaps between meaningful chunks and includes
  time spent executing tools. Active records also expose `currentStreamGapMs`.
  These measure the gateway stream, not network delivery or renderer paint time.
- **model:** each AI SDK provider `doStream` attempt or pi-ai request attempt,
  including first meaningful output, gaps, duration and error category. SDK
  retries produce separate attempts. Duration measures the gateway-observed
  provider response stream, not pure network latency. Retry backoff appears as
  gaps between attempts. Cursor's external CLI exposes chat timing only, not its
  internal model requests or tool execution.
- **tool:** local registered tool execution, with duration and success/error.
  Arguments/results are passed through unchanged and are not stored. Tools
  executed remotely inside a provider are not measured as local tool executions.
- **background:** queued/admitted/finished job and maintenance operations, with
  queue versus execution time. Nested work shares its admitted operation's budget.
- **indexing:** the initial scan's full duration, including any admission waits.
- **setup:** Python environment creation, pip/npm/Chromium installation, including
  timeout/cancellation outcomes. Names are explicit categories, never commands.
- **heap-snapshot:** actual snapshot serialization start/end and outcome.

Errors contain a small category (such as `http_429`, `timeout`, `network`, or
`error`), not exception messages. The recent record cap is 128 per category;
active records are capped at 256. `retention.evictedActive` reports active-record
overflow. Operation traces capture no prompt, generated text, tool arguments/results, raw command, path,
URL, credentials or installer output. Native stack captures have separate contents described below. IDs and tool/provider/model
names remain visible. History is in memory and clears on restart; save the JSON
before restarting if it is needed for diagnosis.

## Reading a stall

- Large event-loop maximum overlapping installer/indexing/snapshot activity:
  investigate that local operation. Temporal overlap is evidence, not proof.
- High chat queue time but low event-loop delay: capacity/admission wait.
- Slow model first response with low local lag/CPU: investigate provider latency,
  network and any preceding setup, rather than treating it as a gateway freeze.
- Long tool execution overlapping a stream gap: inspect that tool/service.
- Heap growth with long GC events: investigate memory pressure.
- High gateway CPU and loop delay: investigate CPU work on the gateway thread.

Resource samples reference operations active at sample time. Short operations
may complete between samples, so also compare operation start/end timestamps
with the resource sample interval. The sampler cannot respond while the gateway
is blocked; inspect the retained evidence after it recovers.


## Independent stall observer (schema 3)

`resources.watchdog` contains the status, snapshot age, retention limits, and
latest `snapshot` from a small, separate Node process. It loads no application
services or database handles. The gateway sends a heartbeat every 500ms; the
observer samples the host every 5s, retains 120 samples, and keeps collecting
while the gateway event loop is blocked. The HTTP endpoint itself still waits
for the gateway to recover. Reading it does not trigger extra OS probes.

The observer returns bounded snapshots over IPC, with at most one outstanding
request. `snapshotAgeMs`, `status`, per-probe `unavailable` reasons and
`collectionFailures` distinguish missing/stale evidence from healthy or zero
measurements. An observer that exits is not automatically respawned in a loop;
restart the gateway to start it again. History is in memory only.

On macOS, each independent sample records:

- Kernel memory-pressure level: **normal**, **warning**, or **critical**.
  Low free RAM alone is not evidence of memory pressure.
- Swap allocated/used/free bytes; VM page size; resident compressor memory,
  original uncompressed size, wired and free memory.
- Page-in/out, swap-in/out, compression/decompression counters since boot, plus
  changes per second between successful samples using actual elapsed time.
  Rates are `null` on the first sample, after unavailable data, or a counter
  reset. These are OS page counters, not measured disk throughput or latency.
- Logical CPU count and load averages, so high load has context.
- Gateway and up to 63 descendants, plus the five highest CPU and memory users
  on the host. Each record has PID, parent PID, executable basename, OS-reported
  CPU percent and RSS bytes. No command-line arguments are requested. Process
  CPU uses `ps` averaging semantics, unlike the gateway's interval CPU metric.
  RSS includes shared pages; do not sum it as unique physical memory. Thread
  workers belong to their containing process; detached/reparented processes and
  Electron siblings may not appear in the gateway descendant list.

Pressure, swap and VM probes are currently macOS-specific. Other systems report
those probes as unsupported; Unix process enumeration and portable memory/load
metrics remain available. OS-denied or timed-out probes are reported as
unavailable, never silently converted to zero. Probes have 2s timeouts and do
not overlap the next host sample if the previous one is still in progress.

After a missing heartbeat for 2.5s, the observer attempts a macOS native `sample`
capture for 1 second at 10ms intervals. This briefly samples all gateway threads
and can identify native I/O, lock waits or CPU work. It does **not** guarantee
JavaScript source lines or capture every short stall. Sampling adds some work;
there is one attempt per continuous stall, a 60s cooldown between attempts, a
6s command deadline and retention of five call graphs capped at 64KiB each.
Failures (including OS restrictions) are retained as evidence too. Captures
include the detection/finish timestamps and last-known operation IDs; those IDs
may be stale or represent queued work and do not prove causation.

`observerGaps` records up to 30 cases where the observer itself was delayed by
more than 1.5s beyond its normal tick. It grants a new heartbeat grace period
following such a gap, avoiding a false gateway attribution immediately after
system sleep or scheduling starvation. This cannot perfectly distinguish all
host scheduling delays from process stalls.

Stack text contains native function/thread names and may contain source or
library identifiers. Header metadata and binary-image lists are removed, and
the user's home-directory prefix is replaced with `~`; this is **not a complete
scrubber of arbitrary symbols or embedded paths**. Review diagnostic exports
before sharing. No heap dump is taken and nothing is uploaded automatically.

Set `PAPR_PERFORMANCE_WATCHDOG=0` before startup to disable the child, or
`PAPR_PERFORMANCE_STACK_SAMPLES=0` to retain host measurements while disabling
native stack sampling. The child is disabled automatically under Vitest/test
mode and stopped on gateway shutdown or IPC disconnect.

## Additional gateway runtime metrics

`resources.samples[].runtime` includes event-loop utilization and active/idle
milliseconds, V8 heap limit and percent used, and per-window resource-usage
deltas: major/minor page faults, filesystem input/output operations, and
voluntary/involuntary context switches. These are OS accounting counters, not
file-byte counts or disk wait times; unsupported counters can be zero on some
platforms. A busy event loop with low CPU may be stuck in a synchronous wait.
Compare that with native stacks and host pressure, not just heap size.

The timeline view also shows the latest 20 host samples, process tables and
expandable stack attempts. The JSON retains the full bounded history. Rebuild
and restart the gateway to activate this version; an existing capture cannot
be retroactively enriched with these measurements.


## Database connection evidence (schema 4)

`resources.watchdog.snapshot.databases` now provides connection identities,
active operations, transaction state, transport coverage and recent slow/error
operations. Each stall also freezes `databaseEvidence` at detection time, before
its native stack capture completes. `nativeDatabaseLockWait` reports whether the
captured main-thread stack contains SQLite's busy handler; missing/false does
not rule out a lock wait outside the sampling interval.

The SQLite-opening sites under `src/gateway` use `openDiagnosticDatabase`. It
retains the native handle and arguments, and traces open, prepare, get/all/run,
exec, pragma, transaction wrappers, cursors and close. This covers metadata,
chat storage, jobs/migrations and the DB query worker. The Turso worker reports
connect, query, write, exec, pull/push, stats and close against a stable connection
ID for each actual native handle. Its requests become active only when executing,
not while waiting in the path scheduler. Turso's internal transaction state is
**unknown**: an in-flight pull does not prove that it currently owns a file lock.

Each connection has:

- A random connection ID, PID, Node thread ID, source ID and fixed code-owner label.
- A database path (home-directory prefix replaced with `~`) and path identity.
  Asynchronous realpath/stat resolution upgrades the database ID to device/inode
  identity, allowing symlinks/hard links to match without extra synchronous I/O.
  If either connection is unresolved, the requested path can still match; if both
  have resolved but different file IDs, they do not match, even at the same path.
  File replacement while a handle is open remains a limitation of path-based
  filesystem observation; this is not an inspection of the engine's file handle.
- Active operation names and start times, with no SQL, parameter, result or token
  contents. Categories include read, write, schema change, checkpoint, and explicit
  BEGIN/COMMIT/ROLLBACK/savepoint control. Unclassified SQL stays `unknown`.
- SQLite transaction state and the time it was first observed active. A transaction
  attempt starts as an operation; it becomes active only after the native handle
  reports `inTransaction`. Deferred transactions are not proof of a write lock.
  Wrapper completion/error records preserve outcomes, including nested rollback.
- Open cursors remain visible until exhausted or explicitly returned, because an
  unfinished iterator can keep a read transaction alive. GC finalizers also clear
  abandoned cursor/connection traces when collected; their timing is nondeterministic. A cursor alone is not
  labeled as the gateway's currently blocked native call.

The independent observer receives updates directly from each process/thread over
an unexported local socket (inside a private temporary directory on Unix; a named
pipe on Windows). The route returns cached observer data and does not probe DBs.
Workers do not relay this evidence through the gateway. Starts are published
before native calls, allowing the observer to retain context while those calls
block. Delivery is best effort: initial connection setup, backpressure, process
failure or observer unavailability can leave gaps. Check source `connected`,
`lastSeenAt`, `droppedUpdates`, collector `droppedRecords`, and snapshot age.

A stall's `waitingCandidates` lists active gateway-main-thread DB calls. Each
candidate contains `suspectedCompetingConnections`: other connected sources on
the same database with active work or an open transaction. Idle connections and
disconnected sources are excluded. These are **suspects**, never asserted lock
owners. Engine-internal activity, external SQLite/Python clients, uninstrumented
connections opened before diagnostics startup, and dropped updates can leave the
owner unknown. A retained capture is historical evidence, not current lock state.

Limits: 256 tracked connections per producer, 16 active operations per connection,
64 producer sockets/sources, 512 observer connections, 128 recent slow (>=50ms),
error or transaction operations. Producer socket backlog is capped before further
updates are attempted; after backpressure it resends current state instead of
replaying an unbounded queue. Incoming frames and buffers are bounded. Traces
are in memory, make no additional SQL queries and upload nothing. Exported paths
and service labels may still identify apps/jobs; no SQL text or values are retained.

Use `PAPR_DATABASE_DIAGNOSTICS=0` before restarting to disable DB tracing while
keeping the rest of the performance watchdog. After rebuilding/restarting, capture
`/api/debug/gateway-performance` again: older native captures cannot be retroactively
assigned database identities. The HTML view shows active DB connections and, under
each stall, the waiting path/connection and suspected competitors or `unknown`.

### Replica contention and vault phases (schema 6)

Routine sync-status reports do not inspect replica-owned files using better-sqlite3.
`legacyArtifactCheck` distinguishes `not-applicable`, `checked`, and `unavailable`;
engine bookkeeping such as `turso_cdc` is not evidence of a legacy migration on a
replica. True legacy migration/repair checks remain. Legacy schema reads use a zero
busy timeout and propagate lock contention rather than silently treating it as no
legacy tables. Engine preflight inspection is skipped while the current worker owns
the path; ownership is invalidated on explicit close and worker shutdown/crash.

Billing refresh requests only schedule `papr:resume-cloud` when the gateway was
paused. `cloudPause` reports current pause state and last transition time; it does
not establish that UI billing and the API-key namespace agree. Vault phase spans
have `parentId` links and record quiet waits, route-readiness waits, preparation,
push HTTP, pull HTTP (including body decoding), and local application separately.
HTTP phase failures remain visible even when a tolerant outer sync method catches
them. An outer completed span therefore does not guarantee all phases succeeded.
No key names, values, response bodies or credentials are stored in these spans.

Database trace activity messages reuse the connection's metadata. Under backpressure,
replaceable state updates coalesce into one atomic current-state snapshot. Slow/error/
transaction completion metadata is copied into a bounded pending ring (128 events);
overflow evicts oldest history and increments `droppedHistory`. `coalescedUpdates`,
`capacityDrops`, `pendingHistory` and `resyncPending` separate congestion from permanent
loss. This remains best-effort diagnostics, not a lossless audit log: brief activity
can be coalesced, transport failure can interrupt delivery, and process exit can lose
pending messages. The private stream preserves message order; resynchronization does
not clear the observer's old state until the complete replacement is received.

Stall evidence also includes connected `otherOpenConnections` for the same database,
including idle Turso handles with unknown native transaction state. These are potential
owners to investigate, not proof of an active transaction or an OS lock. Disconnected
sources remain excluded from this evidence.
