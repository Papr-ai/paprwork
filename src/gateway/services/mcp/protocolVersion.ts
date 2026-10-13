/**
 * Compat for one malformed shape: a 2025-style request body (no per-request envelope) sent
 * with a 2026-era MCP-Protocol-Version header. SDK v2 serves real 2026-07-28 traffic and
 * 2025 traffic from the same handler, but rejects this mismatch with 400 by spec. Claude
 * doesn't always retry, so a 400 means the user's action silently never runs.
 *
 * Here we serve it as the 2025 request its body is, by naming our newest 2025 revision in
 * the header. Requests that carry the envelope are untouched (real 2026-07-28 traffic), and
 * so are malformed or older headers, which the SDK still rejects.
 */
import type { IncomingMessage } from "node:http";
import { LATEST_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";

const HEADER = "mcp-protocol-version";
const DATED = /^\d{4}-\d{2}-\d{2}$/;

function carriesEnvelope(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => {
    const meta = (m as { params?: { _meta?: Record<string, unknown> } } | null)?.params?._meta;
    return typeof meta?.[PROTOCOL_VERSION_META_KEY] === "string";
  });
}

/** Returns the header version it replaced, else null. */
export function legacyBodyWithModernHeader(req: Pick<IncomingMessage, "headers" | "rawHeaders">, body: unknown): string | null {
  const raw = req.headers[HEADER];
  const sent = Array.isArray(raw) ? raw[0] : raw;
  if (!sent || SUPPORTED_PROTOCOL_VERSIONS.includes(sent)) return null;
  if (!DATED.test(sent) || sent <= LATEST_PROTOCOL_VERSION || carriesEnvelope(body)) return null;
  req.headers[HEADER] = LATEST_PROTOCOL_VERSION;
  // The SDK's Node adapter rebuilds the request from rawHeaders, so both must change.
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === HEADER) req.rawHeaders[i + 1] = LATEST_PROTOCOL_VERSION;
  }
  return sent;
}
