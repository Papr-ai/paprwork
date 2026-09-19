/**
 * Per-app origin derivation for mini-app process isolation.
 *
 * A mini-app served from the gateway's own origin shares an agent cluster — and
 * therefore a main thread — with the chat UI, so one app's JavaScript blocks the
 * whole window. Serving each app from `app-<id>.localhost` makes it a distinct
 * *site* (scheme + eTLD+1; `.localhost` has no registrable suffix, so the whole
 * host is the site), which Chromium renders out-of-process.
 *
 * Port is deliberately absent from that computation: `localhost:18790` is the
 * SAME site as `localhost:18789`, so a per-app port would look like isolation
 * and deliver none. The subdomain is what separates them, which is why every
 * app can keep sharing one listener.
 *
 * This module has no imports so both the gateway and the renderer can use it —
 * a mirrored copy on either side would drift, and the two sides must agree
 * exactly or a request lands on the wrong app.
 *
 * See docs/MINI_APP_PROCESS_ISOLATION.md.
 */

/** Hostname prefix identifying a per-app origin. */
export const MINI_APP_HOST_PREFIX = "app-";

/** Suffix every per-app origin carries. RFC 6761 reserves it for loopback. */
export const MINI_APP_HOST_SUFFIX = ".localhost";

/**
 * An app id may only become a hostname label if it is already DNS-safe.
 *
 * Encoding an arbitrary id would work, but it would also make the host
 * unreadable in logs and in the address bar for no benefit: ids are UUIDs.
 * Anything else falls back to the shared origin rather than being mangled —
 * callers must treat `null` as "not isolatable", never as an error.
 */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,50}[a-z0-9])?$/;

/**
 * Hostname for an app's own origin, or null when the id cannot be a DNS label.
 *
 * Null means the caller must fall back to the shared gateway origin — with no
 * isolation, which is a correctness-preserving downgrade and not a failure.
 */
export function miniAppOriginHost(appId: string): string | null {
  const normalized = appId.trim().toLowerCase();
  if (!DNS_LABEL.test(normalized)) {
    return null;
  }
  return `${MINI_APP_HOST_PREFIX}${normalized}${MINI_APP_HOST_SUFFIX}`;
}

/**
 * Full origin for an app, or null when the id cannot be a DNS label.
 *
 * Always http: `.localhost` is a potentially-trustworthy origin under the
 * Secure Contexts spec even over plain http, which is what `originAgentCluster`
 * and the app's own APIs require.
 */
export function miniAppOrigin(appId: string, port: number): string | null {
  const host = miniAppOriginHost(appId);
  return host === null ? null : `http://${host}:${port}`;
}

/**
 * The app id a `Host` header addresses, or null if it addresses the shared
 * gateway origin.
 *
 * The port is stripped before matching because `Host` carries it and the id
 * does not. Matching is case-insensitive: hostnames are, and a browser may
 * normalize differently from however the src was written.
 */
export function appIdFromHost(host: string | undefined): string | null {
  if (!host) {
    return null;
  }
  const hostname = stripPort(host).toLowerCase();
  if (
    !hostname.startsWith(MINI_APP_HOST_PREFIX) ||
    !hostname.endsWith(MINI_APP_HOST_SUFFIX)
  ) {
    return null;
  }
  const id = hostname.slice(
    MINI_APP_HOST_PREFIX.length,
    hostname.length - MINI_APP_HOST_SUFFIX.length,
  );
  // Round-trip through the same rule that produced it: a host we would never
  // emit must not be accepted, or `app-.localhost` resolves to the empty id.
  return DNS_LABEL.test(id) ? id : null;
}

function stripPort(host: string): string {
  // IPv6 literals are bracketed; a bare colon otherwise separates the port.
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    return close === -1 ? host : host.slice(0, close + 1);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}
