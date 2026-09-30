# Gateway background work

The gateway shares one admission budget across coalesced maintenance, initial
index file processing, index batches, and full local job attempts. A job holds
its slot through dependency setup and process/agent completion. Dependency
chains acquire slots per attempt, so a waiting dependency does not retain its
parent's slot. Nested work inside an admitted operation shares that operation's
slot to avoid deadlock; this is an operation budget, not an OS process limit.

`GATEWAY_BG_MAX_CONCURRENCY` controls the idle limit (1–4, default based on CPU
count). Interactive chats retain their existing separate chat capacity. While
chats or other interactive hot paths are active, new background work waits up to
`GATEWAY_BG_MAX_WAIT_MS` (default 120000). After that grace period, only one
background operation may run at a time until the interactive work finishes.
Already-running work is not preempted. Queued jobs can be stopped before launch.

`/api/debug/gateway-background` includes `backgroundBudget.active`,
`backgroundBudget.queued` (with waiting time), and `maxConcurrent`, alongside
existing task timing records and mean event-loop lag. The same payload is
available at `/api/debug/gateway-performance`; see
[GATEWAY_PERFORMANCE_DIAGNOSTICS.md](GATEWAY_PERFORMANCE_DIAGNOSTICS.md) for
resource history, chat/stream timings, and request/tool traces.

Dependency setup uses asynchronous child processes with bounded captured output,
timeouts, and cancellation for job setup. Concurrent Chromium installation
requests share one attempt per gateway lifetime. Directory enumeration uses
asynchronous filesystem I/O; code file reading and hashing use the existing
index I/O worker pool. Symlink directories are skipped to avoid cycles.

Heap snapshot behavior is unchanged by these fixes. For diagnostic sessions,
`PAPRWORK_HEAP_SNAPSHOT_DISABLED=1` disables automatic snapshots while retaining
memory sampling.
