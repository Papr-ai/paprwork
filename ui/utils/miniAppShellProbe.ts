/**
 * Did the preview iframe load the app, or the gateway's "Cannot GET" page?
 *
 * The renderer used to answer this by reading `iframe.contentDocument.title`
 * and `body.innerText` on load. That read throws — and under a per-app origin
 * returns null — so the isolated path gets the same two strings by postMessage
 * from papr-app-bridge instead. One predicate, two inputs: restating the rule
 * per transport is how the two readings drift apart.
 *
 * Absence of the message is itself the signal for the case this exists to
 * catch: Express's default 404 never carries our injected bridge, so nothing
 * announces. The caller bounds that wait rather than treating a slow app as a
 * failure, and retries rather than erroring (Issue 98 — a not-yet-registered
 * route is "ask again", not "this app is gone").
 */

export interface MiniAppShellSignal {
  title?: string | null;
  bodyText?: string | null;
}

/** Express's default 404 for an unregistered /apps/<id>/… route. */
const ROUTE_NOT_READY = "cannot get /apps/";

export function miniAppShellLooksLikeError(signal: MiniAppShellSignal): boolean {
  const title = (signal.title ?? "").toLowerCase();
  const bodyText = (signal.bodyText ?? "").toLowerCase();
  return title.includes("error") || bodyText.includes(ROUTE_NOT_READY);
}

/**
 * How long to wait for the bridge to announce before concluding the response
 * was not ours.
 *
 * The bridge posts during parse, so on a healthy load the message is already
 * queued before the parent's `load` event runs. This window only has to
 * absorb task-ordering jitter, not app startup.
 */
export const MINI_APP_SHELL_ANNOUNCE_GRACE_MS = 2_000;

/**
 * The iframe's document, or null when it is not ours to read.
 *
 * Cross-origin returns null rather than throwing in current engines, but a
 * sandboxed frame without `allow-same-origin` throws a SecurityError — and the
 * caller's decision is the same either way, so both land on null here.
 */
export function readSameOriginDocument(
  iframe: { contentDocument?: Document | null } | null | undefined,
): Document | null {
  if (!iframe) {
    return null;
  }
  try {
    return iframe.contentDocument ?? null;
  } catch {
    return null;
  }
}

export interface ShellAnnouncement {
  type?: string;
  appId?: string;
  title?: string;
  bodyText?: string;
  /** What the frame's own `window.originAgentCluster` said, or null if absent. */
  originAgentCluster?: boolean | null;
}

/**
 * Did the frame actually get its own agent cluster?
 *
 * Three answers, not two. `Origin-Agent-Cluster: ?1` is a request the browser
 * may refuse — and refuses *silently* — so "we asked" is not evidence. But an
 * older frame that predates the bridge reports nothing at all, and reading
 * that absence as a refusal would warn about every shared-origin preview we
 * never asked to isolate. Only an explicit `false` is a refusal.
 */
export function describeIsolationOutcome(
  expected: boolean,
  reported: boolean | null | undefined,
): "isolated" | "shared" | "refused" | "unknown" {
  if (reported === true) {
    return "isolated";
  }
  if (!expected) {
    return "shared";
  }
  return reported === false ? "refused" : "unknown";
}

export function isShellAnnouncementFor(
  appId: string,
  data: unknown,
): data is ShellAnnouncement {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const message = data as ShellAnnouncement;
  return message.type === "papr-preview-booted" && message.appId === appId;
}

/**
 * One iframe load's announce-vs-load race, in the order it actually happens.
 *
 * The bridge posts on DOMContentLoaded, but the frame's `load` event waits for every
 * image, so on a healthy load the announcement arrives FIRST. The old code started the
 * grace timer on `load` without remembering that the announcement already came, so every
 * image-heavy app timed out 2 s later and was remounted — an endless reload loop showing
 * "App routes not ready yet — retrying…".
 */
export class ShellLoadWatch {
  private announced = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly graceMs = MINI_APP_SHELL_ANNOUNCE_GRACE_MS) {}

  /** A new document is about to load (first mount, retry, or src change). */
  begin(): void {
    this.announced = false;
    this.cancel();
  }

  /** The bridge announced a healthy shell for this load. */
  markAnnounced(): void {
    this.announced = true;
    this.cancel();
  }

  /** The frame's `load` fired and its document is unreadable: wait for the bridge. */
  awaitAnnouncement(onSilent: () => void): void {
    this.cancel();
    if (this.announced) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.announced) onSilent();
    }, this.graceMs);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
