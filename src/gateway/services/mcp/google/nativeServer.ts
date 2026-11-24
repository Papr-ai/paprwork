/**
 * Built-in connectors that run in-process instead of talking to a remote MCP
 * server. Google's hosted Gmail/Drive MCP servers are Developer Preview only
 * (enrolled projects), so for production we serve the same MCP surface locally
 * on top of the public, GA Gmail and Drive REST APIs. Sign-in, token storage and
 * server-side refresh are unchanged (serverOAuth through the memory server).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { GoogleTokenSource } from "./googleFetch.js";
import { registerGmailTools } from "./gmailTools.js";
import { registerDriveTools } from "./driveTools.js";

export type NativeConnectorKind = "gmail" | "googledrive";

export const GOOGLE_OAUTH_ENDPOINTS = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
} as const;

export function buildNativeServer(kind: NativeConnectorKind, token: GoogleTokenSource): McpServer {
  const mcp = new McpServer({ name: kind === "gmail" ? "papr-gmail" : "papr-google-drive", version: "1.0.0" });
  if (kind === "gmail") registerGmailTools(mcp, token);
  else registerDriveTools(mcp, token);
  return mcp;
}

/** Start the in-process server and return the client-side transport. */
export async function openNativeTransport(kind: NativeConnectorKind, token: GoogleTokenSource): Promise<Transport> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildNativeServer(kind, token);
  await server.connect(serverSide);
  const close = clientSide.close.bind(clientSide);
  clientSide.close = async () => {
    await close();
    await server.close().catch(() => {});
  };
  return clientSide;
}
