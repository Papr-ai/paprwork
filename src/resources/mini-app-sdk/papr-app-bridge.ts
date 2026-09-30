/**
 * Mini-app side of the parent bridge: paprAPI, runtime log forwarding, and the
 * shell-booted signal.
 *
 * Paprwork used to install all three by reaching into the iframe from the
 * renderer — `iframe.contentDocument.createElement("script")` on the load
 * event. That only works while the iframe shares the chat UI's origin, which
 * is exactly the property mini-app process isolation removes: under a per-app
 * origin `contentDocument` is null, the injection silently no-ops, and an app
 * calling `window.paprAPI.invoke` gets `undefined is not an object` (Issue 16
 * by a different route). Serving the bridge and injecting a blocking <script>
 * works on either origin, so isolation stops being a trade against the API.
 *
 * It is also strictly earlier. The renderer's copy ran on `load` — after every
 * app script had already executed — so an app that touched paprAPI at module
 * scope failed even same-origin. A blocking script in <head> runs during parse,
 * before the app's first line.
 *
 * Idempotent: the renderer keeps its same-origin injection as a fallback for
 * any HTML the gateway did not serve, and that path checks for `paprAPI`
 * before installing. Whichever runs first wins; neither double-installs.
 */

const INVOKE_TIMEOUT_MS = 10_000;

/** Enough of the body to recognise Express's default 404 page. */
const BODY_SNIPPET_CHARS = 200;

declare global {
  interface Window {
    /** Set by the browser when the origin got its own agent cluster. */
    originAgentCluster?: boolean;
    __paprAppBridgeInstalled?: boolean;
    __paprRuntimeLogInstalled?: boolean;
    __PAPR_APP_ID__?: string;
    paprAPI?: { invoke: (method: string, ...args: unknown[]) => Promise<unknown> };
    paprFeatures?: { getAvailability: () => Promise<unknown> };
  }
}

/**
 * Which app is this document?
 *
 * Host first: under isolation the origin *is* the identity, and unlike a path
 * it cannot be rewritten by client-side routing. Falls back to the shared
 * origin's `/apps/<id>/` prefix.
 */
export function readAppIdFromLocation(location: {
  hostname?: string;
  pathname?: string;
}): string | null {
  const hostname = (location.hostname ?? "").toLowerCase();
  if (hostname.startsWith("app-") && hostname.endsWith(".localhost")) {
    const id = hostname.slice("app-".length, -".localhost".length);
    if (id.length > 0) {
      return id;
    }
  }
  const fromPath = /^\/apps\/([^/]+)/.exec(location.pathname ?? "");
  return fromPath ? decodeURIComponent(fromPath[1]) : null;
}

/**
 * Did this document actually land in its own agent cluster?
 *
 * `window.originAgentCluster` is absent on older engines, and absent is not
 * `false` — reporting a missing property as a refusal would have the renderer
 * warn about every browser that simply cannot answer.
 */
export function readOriginAgentCluster(win: {
  originAgentCluster?: unknown;
}): boolean | null {
  return typeof win.originAgentCluster === "boolean"
    ? win.originAgentCluster
    : null;
}

function stringifyLogArg(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function installRuntimeLogForwarding(appId: string): void {
  if (window.__paprRuntimeLogInstalled) {
    return;
  }
  window.__paprRuntimeLogInstalled = true;

  const send = (
    level: string,
    message: unknown,
    source?: string,
    line?: number,
    column?: number,
  ): void => {
    try {
      window.parent.postMessage(
        {
          type: "papr-runtime-log",
          appId,
          entry: {
            level,
            message: String(message),
            source: source || undefined,
            line: line || undefined,
            column: column || undefined,
            timestamp: new Date().toISOString(),
            origin: "iframe",
          },
        },
        "*",
      );
    } catch {
      /* parent gone */
    }
  };

  window.addEventListener("error", (event) => {
    send(
      "error",
      event.message || String(event.error),
      event.filename,
      event.lineno,
      event.colno,
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { message?: string } | undefined;
    send("error", `Unhandled rejection: ${reason?.message ?? String(event.reason)}`);
  });

  for (const level of ["error", "warn"] as const) {
    const original = console[level];
    if (!original) {
      continue;
    }
    console[level] = (...args: unknown[]) => {
      send(level, args.map(stringifyLogArg).join(" "));
      return original.apply(console, args);
    };
  }
}

function installPaprApi(appId: string): void {
  window.__PAPR_APP_ID__ = appId;

  if (!window.paprAPI) {
    window.paprAPI = {
      invoke(method: string, ...args: unknown[]): Promise<unknown> {
        return new Promise((resolve, reject) => {
          const id = `papr-invoke-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const handler = (event: MessageEvent) => {
            const data = event.data as
              | { type?: string; id?: string; error?: string; result?: unknown }
              | undefined;
            if (data?.type !== "papr-invoke-response" || data.id !== id) {
              return;
            }
            window.removeEventListener("message", handler);
            clearTimeout(timer);
            if (data.error) {
              reject(new Error(data.error));
            } else {
              resolve(data.result);
            }
          };
          const timer = setTimeout(() => {
            window.removeEventListener("message", handler);
            reject(new Error(`Electron API call timed out: ${method}`));
          }, INVOKE_TIMEOUT_MS);
          window.addEventListener("message", handler);
          window.parent.postMessage(
            { type: "papr-invoke-request", id, appId, method, args },
            "*",
          );
        });
      },
    };
  }

  if (!window.paprFeatures) {
    window.paprFeatures = {
      getAvailability(): Promise<unknown> {
        return fetch(
          `/api/apps/${encodeURIComponent(appId)}/feature-availability`,
        ).then((res) => {
          if (!res.ok) {
            throw new Error("Feature availability request failed");
          }
          return res.json();
        });
      },
    };
  }
}

/**
 * Tell the renderer our HTML was served and hand it the same two strings it
 * used to read off `contentDocument`.
 *
 * The renderer's error check ("Cannot GET /apps/…") exists to catch Express's
 * default 404, which never carries this script — so the *absence* of this
 * message is the signal in that case, and the renderer bounds the wait rather
 * than treating a slow app as a failure.
 *
 * `originAgentCluster` rides along because it is the only *evidence* isolation
 * took effect. `Origin-Agent-Cluster: ?1` is a request, not a guarantee — the
 * browser may refuse it (another document on this origin already resolved the
 * other way) and there is no error when it does. Reading it from inside the
 * frame is the one place the answer is knowable.
 */
function announceShell(appId: string, cluster: boolean | null): void {
  const post = () => {
    try {
      window.parent.postMessage(
        {
          type: "papr-preview-booted",
          appId,
          title: document.title ?? "",
          bodyText: document.body?.innerText?.slice(0, BODY_SNIPPET_CHARS) ?? "",
          originAgentCluster: cluster,
        },
        "*",
      );
    } catch {
      /* parent gone */
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", post, { once: true });
  } else {
    post();
  }
}

export function installPaprAppBridge(): void {
  if (window.__paprAppBridgeInstalled) {
    return;
  }
  const appId = readAppIdFromLocation(window.location);
  if (!appId) {
    return;
  }
  window.__paprAppBridgeInstalled = true;
  installRuntimeLogForwarding(appId);
  installPaprApi(appId);
  announceShell(appId, readOriginAgentCluster(window));
}

if (typeof window !== "undefined") {
  installPaprAppBridge();
}
