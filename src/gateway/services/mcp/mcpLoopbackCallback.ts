/**
 * One-shot loopback listener for an MCP OAuth redirect.
 *
 * Why loopback rather than the papr:// deep link: every DCR-capable MCP server
 * we probed accepted `http://127.0.0.1:<port>/…` (RFC 8252 native-app redirect)
 * while custom schemes are rejected by several. The port range is fixed so a
 * dynamically-registered client's redirect_uri stays valid across sign-ins.
 */

import http from "node:http";
import { findAvailablePort } from "../../../core/services/OAuthCallbackServer.js";

export const MCP_CALLBACK_START_PORT = 18793;
export const MCP_CALLBACK_PATH = "/mcp/callback";

export interface LoopbackCallback {
  redirectUri: string;
  /** Resolves with the authorization code; rejects on error, state mismatch, or timeout. */
  waitForCode: Promise<string>;
  close: () => void;
}

const page = (ok: boolean, title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f7f7f8;color:#111}
.c{text-align:center;max-width:420px;padding:32px}.i{font-size:40px;color:${ok ? "#16a34a" : "#dc2626"}}</style></head>
<body><div class="c"><div class="i">${ok ? "✓" : "✕"}</div><h2>${title}</h2><p>${body}</p></div>
${ok ? "<script>setTimeout(()=>window.close(),1500)</script>" : ""}</body></html>`;

const esc = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export async function startLoopbackCallback(opts: {
  expectedState: string;
  serviceName: string;
  timeoutMs: number;
}): Promise<LoopbackCallback> {
  const port = await findAvailablePort(MCP_CALLBACK_START_PORT, "127.0.0.1", 10);
  const redirectUri = `http://127.0.0.1:${port}${MCP_CALLBACK_PATH}`;

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const waitForCode = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  // Callers may abandon the promise (e.g. connect fails before redirect).
  waitForCode.catch(() => {});

  let settled = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== MCP_CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const send = (status: number, html: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    };
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (error) {
      const desc = url.searchParams.get("error_description") || error;
      send(400, page(false, "Sign-in didn't finish", `${esc(desc)}<br/>Close this tab and try again from Papr Work.`));
      finish(new Error(`Authorization failed: ${desc}`));
    } else if (!code) {
      send(400, page(false, "Sign-in didn't finish", "No authorization code came back."));
    } else if (state !== opts.expectedState) {
      // A stale tab from an earlier attempt landed here. Reject it, but keep
      // waiting: it must not abort the sign-in the user is doing right now.
      send(400, page(false, "This sign-in link is out of date", "Close this tab and approve in the most recent sign-in tab."));
    } else {
      send(200, page(true, `${esc(opts.serviceName)} connected`, "Head back to Papr Work. You can close this tab."));
      finish(null, code);
    }
  });

  const timer = setTimeout(() => finish(new Error("Timed out waiting for sign-in")), opts.timeoutMs);

  function finish(err: Error | null, code?: string) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    setTimeout(() => server.close(), 500);
    if (err) rejectCode(err);
    else resolveCode(code as string);
  }

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => res());
  });

  return {
    redirectUri,
    waitForCode,
    close: () => finish(new Error("Sign-in cancelled")),
  };
}
