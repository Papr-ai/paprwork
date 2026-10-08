/**
 * apps.papr.ai/oauth/callback → memory server /v1/cloud/oauth/callback.
 *
 * Providers send the user here after they approve. The memory server checks
 * `state`, exchanges the code with the PKCE verifier (and the org's client
 * secret when there is one), writes the token to the vault, then answers with
 * a redirect (desktop: papr://…) or a small "connected" page. We pass that
 * answer through unchanged and never look at or log the code.
 */

import type { Request, Response } from "express";
import { getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";

const ALLOWED = ["state", "code", "error", "error_description"] as const;
const TIMEOUT_MS = 30_000;

function memoryBase(): string {
  return getMemoryServerBaseUrl().replace(/\/+$/, "");
}

export function callbackUpstreamUrl(query: Request["query"], base = memoryBase()): string {
  const params = new URLSearchParams();
  for (const k of ALLOWED) {
    const v = query[k];
    if (typeof v === "string" && v) params.set(k, v.slice(0, 4096));
  }
  return `${base}/v1/cloud/oauth/callback?${params.toString()}`;
}

/** Only pass through redirects back into Papr (desktop deep link or our own pages). */
export function safeRedirect(location: string | null): string | null {
  if (!location) return null;
  return /^papr:\/\//.test(location) || /^https:\/\/([a-z0-9-]+\.)*papr\.ai\//.test(location) ? location : null;
}

export async function proxyOAuthCallback(req: Request, res: Response): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    const upstream = await fetch(callbackUpstreamUrl(req.query), {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "text/html" },
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      const to = safeRedirect(upstream.headers.get("location"));
      if (to) {
        res.redirect(302, to);
        return;
      }
    }
    res.status(upstream.status).type("html").send(await upstream.text());
  } catch {
    res.status(502).type("html").send(
      "<!doctype html><meta charset=utf-8><title>Sign-in failed</title>" +
        "<p style=\"font:15px system-ui;text-align:center;margin-top:30vh\">Papr couldn't finish the sign-in. Go back to Papr and try again.</p>",
    );
  }
}
