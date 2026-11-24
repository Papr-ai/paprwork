# Papr Work OAuth client metadata (CIMD)

`papr-work-client.json` is Papr Work's **Client ID Metadata Document** (MCP spec 2025-11-25, SEP-991).
MCP servers that advertise `client_id_metadata_document_supported: true` (e.g. heyBTW) accept the
document's URL as the `client_id`: no dynamic registration and no per-vendor setup.

## Enable
1. Host this file byte-for-byte at the URL in its `client_id` (`https://papr.ai/oauth/papr-work-client.json`),
   `Content-Type: application/json`. `client_id` must equal the hosting URL exactly.
2. Set `PAPR_MCP_CLIENT_METADATA_URL=https://papr.ai/oauth/papr-work-client.json` (packaged gateway env).

Until (2) is set, the SDK uses dynamic registration exactly as before.

## Redirects
- Desktop loopback: `http://127.0.0.1:18793-18802/mcp/callback` (first free port; see `mcpLoopbackCallback.ts`).
- Server sign-in / team connections: `https://apps.papr.ai/oauth/callback`.

Precedence per server: catalog `clientId` > admin vault `MCP_<ID>_CLIENT_ID` > CIMD > dynamic registration.
