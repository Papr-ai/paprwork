/**
 * Refuse honestly while the gateway is still registering routes.
 *
 * The HTTP server binds before `initializeServices()` so the supervisor's health
 * probe can answer during a cold start that legitimately takes 60s+. Every real
 * route — `/api/*`, `/apps/*` — is registered after that, and `gatewayReady`
 * flips only once they all are. A request arriving in between matched no route
 * and fell through to Express's default handler, which renders
 * `Cannot GET /apps/<id>/index.html`: a sentence that means "this does not
 * exist" and is indistinguishable from a deleted app. The gateway already knew
 * the difference — `/health` reports `"starting"` vs `"ok"` — and nothing else
 * consulted it.
 *
 * Two shapes of caller, so two shapes of answer:
 *
 *  - A document navigation (the mini-app iframe) renders whatever body it is
 *    given, which is why the 404 stayed on screen: the document *loaded*, so
 *    `onload` fired and `onerror` did not, and the renderer's retry never ran.
 *    It also cannot be inspected from the renderer — in development the UI is on
 *    a Vite port and the app is on 18789, so reading `contentDocument` is a
 *    cross-origin error. So the page we hand back polls `/health` itself and
 *    reloads when the gateway says `"ok"`. It is same-origin with `/health` by
 *    construction, needs no assets, and repairs itself with no renderer
 *    involvement.
 *
 *  - Everything else gets JSON, because a mini-app that parses an HTML body as
 *    JSON fails in a way that reads like a bug in the app.
 *
 * Both carry 503 and `Retry-After`. Status matters more than the body here: 503
 * says "ask again", 404 says "stop asking", and choosing the wrong one sends the
 * user to look for a file that was never missing.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * How long the retry page waits before it stops reloading and offers the choice
 * to the user.
 *
 * Deliberately longer than the 60s the Electron main process waits before it
 * gives up and loads the UI anyway: this page exists precisely because that
 * budget was blown, so a shorter one here would hand back a dead end in the one
 * situation it was written for.
 */
export const BOOT_GATE_MAX_WAIT_MS = 180_000;

/** Gap between `/health` polls from the retry page. */
export const BOOT_GATE_POLL_INTERVAL_MS = 750;

/** Seconds we ask a programmatic caller to wait. */
export const BOOT_GATE_RETRY_AFTER_SECONDS = 1;

/**
 * Paths that must answer during boot.
 *
 * `/health` is registered ahead of this gate and so never reaches it, but it is
 * named here anyway: this list is what the retry page depends on to find out
 * when to stop waiting, and a future reorder that moved `/health` behind the
 * gate would otherwise deadlock it against itself.
 */
export const BOOT_GATE_EXEMPT_PREFIXES = ["/health"] as const;

export function isBootGateExemptPath(pathname: string): boolean {
  return BOOT_GATE_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Does this request want a page, or an answer?
 *
 * Keyed on the `Accept` header rather than the file extension: the iframe asks
 * for `index.html` here, but an app's own `fetch("/api/db/query")` and a
 * `fetch("./data.json")` both want JSON regardless of what they are named, and
 * handing either an HTML retry page produces a parse error that looks like the
 * app is broken. A request with no `Accept` at all is treated as programmatic,
 * which is what `fetch` defaults and browsers never do for navigation.
 */
export function prefersHtmlDocument(req: Pick<Request, "accepts">): boolean {
  return req.accepts(["json", "html"]) === "html";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A self-contained page that waits for the gateway and then loads the real one.
 *
 * Everything is inline. During boot the static asset handler may not be
 * registered either, so a page that referenced a stylesheet or a script would
 * render unstyled and dead — the exact failure it exists to replace.
 */
export function renderBootGatePage(requestedPath: string): string {
  const safePath = escapeHtml(requestedPath);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting…</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #3c3c43; background: #f5f5f7;
  }
  .card { max-width: 30rem; padding: 2rem; text-align: center; }
  .spinner {
    width: 18px; height: 18px; margin: 0 auto 1rem;
    border: 2px solid rgba(0,0,0,.15); border-top-color: #0071e3;
    border-radius: 50%; animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { margin: 0 0 .5rem; font-size: 15px; font-weight: 600; color: #1d1d1f; }
  p { margin: 0; opacity: .75; }
  code { font-size: 11px; opacity: .55; word-break: break-all; }
  button {
    margin-top: 1.25rem; padding: .5rem 1rem; font: inherit; font-weight: 500;
    color: #fff; background: #0071e3; border: 0; border-radius: 8px; cursor: pointer;
  }
  .hidden { display: none; }
  @media (prefers-color-scheme: dark) {
    body { color: #a1a1a6; background: #1c1c1e; }
    h1 { color: #f5f5f7; }
    .spinner { border-color: rgba(255,255,255,.18); border-top-color: #0a84ff; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="spinner" id="spinner"></div>
    <h1 id="title">Starting the local gateway…</h1>
    <p id="detail">This app will open as soon as the gateway finishes loading.</p>
    <p><code>${safePath}</code></p>
    <button id="retry" class="hidden">Try again</button>
  </div>
<script>
(function () {
  var deadline = Date.now() + ${BOOT_GATE_MAX_WAIT_MS};
  var timer = null;

  function giveUp() {
    if (timer) { clearTimeout(timer); timer = null; }
    document.getElementById("spinner").className = "hidden";
    document.getElementById("title").textContent = "The gateway is taking longer than usual";
    document.getElementById("detail").textContent =
      "It is still starting. Your app is not missing — nothing has been lost.";
    document.getElementById("retry").className = "";
  }

  function poll() {
    // Bounded: a page that reloaded forever would spin silently for as long as
    // the gateway stayed wedged, with nothing on screen to say so.
    if (Date.now() > deadline) { giveUp(); return; }
    fetch("/health", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        if (body && body.status === "ok") { location.reload(); return; }
        timer = setTimeout(poll, ${BOOT_GATE_POLL_INTERVAL_MS});
      })
      .catch(function () { timer = setTimeout(poll, ${BOOT_GATE_POLL_INTERVAL_MS}); });
  }

  document.getElementById("retry").addEventListener("click", function () {
    location.reload();
  });
  poll();
})();
</script>
</body>
</html>
`;
}

/**
 * Middleware that answers for routes that do not exist yet.
 *
 * Register it *after* whatever must stay reachable during boot and *before* the
 * routes that are registered later. `isReady` is read per request rather than
 * captured, so the gate opens the moment the gateway finishes.
 */
export function createGatewayBootGate(isReady: () => boolean): RequestHandler {
  return function gatewayBootGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (isReady() || isBootGateExemptPath(req.path)) {
      next();
      return;
    }

    // Never cached: a cached retry page would sit in front of the real app for
    // the rest of the session.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", String(BOOT_GATE_RETRY_AFTER_SECONDS));

    if (prefersHtmlDocument(req)) {
      res.status(503).type("html").send(renderBootGatePage(req.originalUrl));
      return;
    }

    res.status(503).json({
      error: "Gateway is still starting",
      phase: "starting",
      retryAfterMs: BOOT_GATE_RETRY_AFTER_SECONDS * 1000,
    });
  };
}
