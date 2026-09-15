/**
 * First-chunk watchdog — catches a turn that delivered nothing at all.
 *
 * FIRST chunk only, and that is the whole design constraint. A single long
 * tool call (a bash build, a scrape) legitimately emits nothing for minutes,
 * so an inter-chunk idle timeout would kill working turns. Once a chunk
 * arrives the request is retired and can never be armed again.
 *
 * Why silence before the first chunk is different: a healthy turn reports in
 * within seconds. The concurrency gate yields `concurrency-queued` *before* it
 * blocks, so even a turn waiting behind three others answers immediately; the
 * only work ahead of that is auth resolution (IPC, 15s ceiling) and loading the
 * session. Gateway boot is excluded too, because `gateway.stream` awaits the
 * connection before it registers the request and arms this timer.
 *
 * So total silence past the budget means the turn is not reaching us: either
 * the socket died without the heartbeat noticing yet (12 missed beats × 20s =
 * 240s while a stream is active, deliberately lax so a heavy turn is not
 * interrupted), or the server no longer has this socket as a subscriber. Both
 * leave the composer spinning with no error and no answer.
 */

/**
 * 60s against a ~15-20s worst-case first chunk. Wide enough that a slow but
 * working turn is never disturbed; short enough that the user is not staring
 * at dots for the heartbeat's 240s.
 */
export const FIRST_CHUNK_STALL_MS = 60_000;

/**
 * Reason used to release the original stream promise once we stop waiting on it.
 *
 * MUST satisfy `isExpectedStreamCancellation`, because that is what makes
 * `gateway.cancelRequest` resolve the promise instead of rejecting it — a
 * rejection here would surface an error for a turn that is about to be
 * recovered and shown. Pinned by a test, since tightening that matcher would
 * otherwise silently turn recovery into a user-visible failure.
 *
 * Client-side only: the server keeps running the turn, which is the point —
 * recovery resubscribes and collects the result.
 */
export const FIRST_CHUNK_STALL_CANCEL_REASON =
  "aborted: no first chunk — recovering";

/** Retired requestIds kept so a delivered stream cannot re-arm. */
const MAX_REMEMBERED_REQUESTS = 200;

export interface FirstChunkStall {
  chatId: string;
  requestId: string;
  waitedMs: number;
}

interface WatchdogEntry {
  requestId: string;
  armedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** At most one armed entry per chat — a chat has at most one live stream. */
const armedByChatId = new Map<string, WatchdogEntry>();

/** Requests that delivered a chunk (or were disarmed); never armed again. */
const retiredRequestIds = new Set<string>();

function retire(requestId: string): void {
  retiredRequestIds.add(requestId);
  while (retiredRequestIds.size > MAX_REMEMBERED_REQUESTS) {
    const oldest = retiredRequestIds.values().next();
    if (oldest.done) break;
    retiredRequestIds.delete(oldest.value);
  }
}

function clearArmed(chatId: string): void {
  const entry = armedByChatId.get(chatId);
  if (!entry) return;
  clearTimeout(entry.timer);
  armedByChatId.delete(chatId);
}

/**
 * Arm the watchdog for a freshly registered `agent:stream` request.
 *
 * Deliberately not armed on resubscribe: a resume re-attaches to a stream that
 * may be mid-tool, where no chunk for minutes is the correct behaviour.
 *
 * Returns false when the request already delivered — the guard that keeps this
 * from degrading into an idle timeout.
 */
export function armFirstChunkWatchdog(args: {
  chatId: string;
  requestId: string;
  onStall: (stall: FirstChunkStall) => void;
  timeoutMs?: number;
}): boolean {
  const { chatId, requestId, onStall } = args;
  const timeoutMs = args.timeoutMs ?? FIRST_CHUNK_STALL_MS;

  if (retiredRequestIds.has(requestId)) {
    return false;
  }

  // A new request supersedes whatever was armed for this chat.
  clearArmed(chatId);

  const armedAt = Date.now();
  const timer = setTimeout(() => {
    const current = armedByChatId.get(chatId);
    if (!current || current.requestId !== requestId) return;
    armedByChatId.delete(chatId);
    retire(requestId);
    onStall({ chatId, requestId, waitedMs: Date.now() - armedAt });
  }, timeoutMs);

  armedByChatId.set(chatId, { requestId, armedAt, timer });
  return true;
}

/**
 * A chunk was accepted for this chat: the turn is being delivered.
 *
 * `requestId` is optional because broadcast chunks carry none. When it is
 * present and does not match, the chunk belongs to a superseded stream and
 * says nothing about the armed one.
 */
export function noteStreamChunkArrived(
  chatId: string,
  requestId?: string,
): void {
  const entry = armedByChatId.get(chatId);
  if (!entry) return;
  if (requestId !== undefined && requestId !== entry.requestId) return;

  clearTimeout(entry.timer);
  armedByChatId.delete(chatId);
  retire(entry.requestId);
}

/** Stop watching this chat (stream untracked, stopped, or superseded). */
export function disarmFirstChunkWatchdog(chatId: string): void {
  const entry = armedByChatId.get(chatId);
  if (!entry) return;
  clearTimeout(entry.timer);
  armedByChatId.delete(chatId);
  retire(entry.requestId);
}

export function isFirstChunkWatchdogArmed(chatId: string): boolean {
  return armedByChatId.has(chatId);
}

export function resetFirstChunkWatchdogForTests(): void {
  for (const entry of armedByChatId.values()) {
    clearTimeout(entry.timer);
  }
  armedByChatId.clear();
  retiredRequestIds.clear();
}
