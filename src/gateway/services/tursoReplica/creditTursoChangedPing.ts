/**
 * Credits: tell the memory server a Turso database was just written, so it can bill
 * the reads/writes within minutes (POST /v1/credits/turso/changed).
 *
 * Fire-and-forget and coalesced: pushes in the same window collapse into one request
 * with every database name. The server debounces again per database, so this only has
 * to avoid flooding it. Never throws, never blocks a push.
 */

import { cloudApiFetch } from "../../utils/cloudApiClient.js";

/** One request per window, regardless of how many pushes happened in it. */
export const TURSO_CHANGED_PING_WINDOW_MS = 60_000;
const MAX_NAMES_PER_PING = 100;

const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

type Sender = (names: string[]) => Promise<void>;

async function defaultSend(names: string[]): Promise<void> {
  await cloudApiFetch("/v1/credits/turso/changed", {
    method: "POST",
    body: { databases: names },
    timeoutMs: 10_000,
    compressBody: false,
  });
}

let send: Sender = defaultSend;

function flush(): void {
  timer = null;
  if (pending.size === 0) {
    return;
  }
  const names = [...pending].slice(0, MAX_NAMES_PER_PING);
  for (const n of names) {
    pending.delete(n);
  }
  void send(names).catch(() => {
    // Best effort: the nightly sweep bills anything a missed ping did not.
  });
  if (pending.size > 0) {
    timer = setTimeout(flush, TURSO_CHANGED_PING_WINDOW_MS);
  }
}

/** Call after a successful push. `tursoDatabase` is the short name (d-xxxx / job db). */
export function noteTursoDatabaseChanged(tursoDatabase: string | null | undefined): void {
  const name = tursoDatabase?.trim();
  if (!name || process.env.PAPR_CREDITS_TURSO_PING === "0") {
    return;
  }
  pending.add(name);
  if (!timer) {
    timer = setTimeout(flush, TURSO_CHANGED_PING_WINDOW_MS);
    timer.unref?.();
  }
}

/** Test hooks. */
export function __setTursoChangedSenderForTests(fn: Sender | null): void {
  send = fn ?? defaultSend;
}

export function __flushTursoChangedPingForTests(): void {
  if (timer) {
    clearTimeout(timer);
  }
  flush();
}

export function __pendingTursoChangedForTests(): string[] {
  return [...pending];
}
