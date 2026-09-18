/**
 * Decide which origin a local mini-app preview iframe loads from.
 *
 * Isolated (`http://app-<id>.localhost:<port>`) makes the app a distinct site,
 * so Chromium gives it its own process and its JavaScript can no longer block
 * the chat UI's main thread. Shared (`http://<host>:<port>`) is the legacy
 * behaviour and is still what runs with the flag off.
 *
 * See docs/MINI_APP_PROCESS_ISOLATION.md.
 */

import { miniAppOrigin } from "../../src/core/miniApps/miniAppOrigin.js";

export interface MiniAppPreviewOriginOptions {
  appId: string;
  /** VITE_GATEWAY_HOST, or its default. */
  host: string;
  /** VITE_GATEWAY_PORT, or its default. */
  port: string;
  /** VITE_PAPR_MINI_APP_ISOLATION. */
  isolationFlag: string | undefined;
}

export interface MiniAppPreviewOrigin {
  origin: string;
  isolated: boolean;
}

function isolationRequested(flag: string | undefined): boolean {
  return flag === "1" || flag === "true";
}

/**
 * Per-app subdomains only exist under `localhost`.
 *
 * If the gateway is reached by IP or by any other hostname there is no
 * `.localhost` suffix to hang a subdomain off, and inventing one would produce
 * a host that does not resolve — a blank iframe rather than a slow one. Falling
 * back to the shared origin keeps the app working without isolation, which is
 * the right trade.
 */
function supportsPerAppSubdomain(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

/**
 * Are previews isolated *in this deployment*, independent of any one app?
 *
 * Callers that size the warm set need this without naming an app, and asking
 * `resolveMiniAppPreviewOrigin` with a placeholder id would answer a different
 * question — a single un-isolatable id would then decide the policy for all.
 */
export function miniAppPreviewIsolationEnabled(
  options: Pick<MiniAppPreviewOriginOptions, "host" | "isolationFlag">,
): boolean {
  return (
    isolationRequested(options.isolationFlag) &&
    supportsPerAppSubdomain(options.host)
  );
}

export function resolveMiniAppPreviewOrigin({
  appId,
  host,
  port,
  isolationFlag,
}: MiniAppPreviewOriginOptions): MiniAppPreviewOrigin {
  const shared = { origin: `http://${host}:${port}`, isolated: false };
  if (!miniAppPreviewIsolationEnabled({ host, isolationFlag })) {
    return shared;
  }
  const parsedPort = Number.parseInt(port, 10);
  if (!Number.isFinite(parsedPort)) {
    return shared;
  }
  // Null means the id could not be a DNS label — not isolatable, not an error.
  const isolated = miniAppOrigin(appId, parsedPort);
  return isolated === null ? shared : { origin: isolated, isolated: true };
}

/**
 * Full iframe src for a local preview.
 *
 * The `/apps/<id>/` path is kept on the isolated origin too, so the app's own
 * relative asset URLs resolve unchanged and the gateway route needs no rewrite.
 */
export function resolveMiniAppPreviewSrc(
  options: MiniAppPreviewOriginOptions,
): string {
  const { origin } = resolveMiniAppPreviewOrigin(options);
  return `${origin}/apps/${options.appId}/index.html`;
}
