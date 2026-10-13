/**
 * Claude can send an MCP-Protocol-Version newer than our SDK knows (e.g. 2026-07-28 while
 * @modelcontextprotocol/sdk 1.32.1, the newest release, tops out at 2025-11-25). The SDK
 * transport answers 400 to any unknown version, and Claude doesn't always retry, so the
 * user's action silently never runs.
 *
 * The spec lets a server answer with the newest version it supports (initialize already
 * does this in the SDK). This applies the same rule to the per-request header: a
 * well-formed version newer than ours is treated as our latest. Malformed or unknown
 * older versions are left alone and still rejected by the SDK.
 */
import type { IncomingMessage } from "node:http";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

const HEADER = "mcp-protocol-version";
const DATED = /^\d{4}-\d{2}-\d{2}$/;

/** Returns the version the client sent when it was replaced, else null. */
export function downgradeNewerProtocolVersion(req: Pick<IncomingMessage, "headers" | "rawHeaders">): string | null {
  const raw = req.headers[HEADER];
  const sent = Array.isArray(raw) ? raw[0] : raw;
  if (!sent || SUPPORTED_PROTOCOL_VERSIONS.includes(sent)) return null;
  if (!DATED.test(sent) || sent <= LATEST_PROTOCOL_VERSION) return null;
  req.headers[HEADER] = LATEST_PROTOCOL_VERSION;
  // The SDK's Node transport rebuilds the request from rawHeaders, so both must change.
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === HEADER) req.rawHeaders[i + 1] = LATEST_PROTOCOL_VERSION;
  }
  return sent;
}
