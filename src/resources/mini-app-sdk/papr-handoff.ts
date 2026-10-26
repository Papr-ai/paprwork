/**
 * Hand-offs into an app: Claude's "Open in Papr" (and the web's "Open in Papr Work") land the
 * user in this app on their Mac. If the app was already open, it doesn't reload: listen here
 * and move to what the hand-off names.
 *
 *   import { papr } from '/__papr__/papr-sdk.ts';
 *   papr.onHandoff(async ({ view }) => {          // view: what the card passed, e.g. "outreach:c_123"
 *     await reload();                              // Papr pulled the card's cloud writes first
 *     goTo(view);
 *   });
 *
 * Also fires for a hand-off that opened the app, if it arrived in the last minute, so one
 * handler covers "app was open" and "app just opened".
 */

export interface PaprHandoff {
  /** The view the card passed to papr_continue_on_mac, e.g. "outreach:c_123". */
  view?: string;
  /** Where the user came from: "claude" or "web". */
  source: string;
  /** ISO time the hand-off reached this app. */
  at: string;
}

type Listener = (h: PaprHandoff) => void | Promise<void>;

const FRESH_MS = 60_000;

interface HandoffMessage {
  type: "papr-handoff";
  nonce: string;
  view?: unknown;
  source?: unknown;
}

/** Testable core: one listener per window, deduped by nonce, last hand-off kept for late subscribers. */
export function createHandoffChannel(win: Pick<Window, "addEventListener" | "parent">, now = () => Date.now()) {
  const listeners = new Set<Listener>();
  const seen = new Set<string>();
  let last: { h: PaprHandoff; t: number } | null = null;
  win.addEventListener("message", (event: MessageEvent) => {
    const d = event.data as HandoffMessage | null;
    if (!d || d.type !== "papr-handoff" || typeof d.nonce !== "string") return;
    if (event.source !== win.parent || seen.has(d.nonce)) return;
    seen.add(d.nonce);
    const h: PaprHandoff = {
      ...(typeof d.view === "string" && d.view ? { view: d.view.slice(0, 200) } : {}),
      source: typeof d.source === "string" ? d.source.slice(0, 40) : "claude",
      at: new Date(now()).toISOString(),
    };
    last = { h, t: now() };
    for (const fn of listeners) void Promise.resolve(fn(h)).catch(() => {});
  });
  return {
    onHandoff(fn: Listener): () => void {
      listeners.add(fn);
      if (last && now() - last.t < FRESH_MS) void Promise.resolve(fn(last.h)).catch(() => {});
      return () => listeners.delete(fn);
    },
  };
}

const channel = typeof window !== "undefined" ? createHandoffChannel(window) : null;

/** Run `fn` when Papr hands the user to this app (from Claude or the web). Returns unsubscribe. */
export function onHandoff(fn: Listener): () => void {
  return channel ? channel.onHandoff(fn) : () => {};
}
