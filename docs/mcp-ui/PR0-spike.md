# PR 0 · MCP UI spike: one Papr card in Claude

Architecture: Papr × Claude · MCP UI Architecture (mini-app). This spike tests the two unknowns
everything else rests on before we build PRs 1–6:

1. **Does Claude (Cowork / Desktop / claude.ai) render our MCP App card, and can that card call back
   through a hidden tool?**
2. **Does our Auth0 tenant pass Claude's connector sign-in?**

## What's in the code

| File | What it does |
|---|---|
| `src/gateway/services/mcp/server.ts` | Stateless Streamable HTTP endpoint at `/mcp` on the Cloud App Host. Tools: `papr_open_app` (model-visible, carries the card) and `papr_api` (`visibility: ["app"]`, hidden from the model). |
| `src/gateway/services/mcp/auth.ts` | RFC 9728 protected-resource metadata, Auth0 RS256 access-token check (JWKS), caller from Papr claims. |
| `src/gateway/services/mcp/apiTunnel.ts` | `papr_api` → loopback HTTP to the same host's `/api/*` handlers with the caller's session. Allowlisted paths only (no `bash/run`, no `credentials`). |
| `src/gateway/services/mcp/spikeCard.ts` | One self-contained HTML card (~320 KB, ext-apps `App` inlined). Lists the app's tables via `/api/db/query` through the tunnel, follows Claude's theme, "Open in Papr" via `ui/open-link`. |
| `src/gateway/cloud-app-host.ts` | Mounts it when `PAPR_MCP_ENABLED=1`. Off by default, so merging changes nothing in prod. |

The tunnel goes through the real HTTP handlers, so cards inherit every existing check: per-app access,
read-only SQL guard, rate limits (keyed by session), row caps and per-user isolation. No duplicated rules.

Tests: `npx vitest run --config vitest.config.unit.ts src/gateway/services/mcp` (17 tests: 401 + metadata,
tool list/visibility, card resource, open allowed/denied, tunnel round trip with headers, allowlist guards).

## Auth0 setup (needed before testing in Claude)

1. **API**: create an Auth0 API, identifier `https://mcp.papr.ai/mcp`, RS256, allow offline access.
2. **Resource → audience**: Claude sends RFC 8707 `resource=`. Turn on Auth0's *Resource Parameter
   Compatibility Profile* (Tenant Settings → Advanced) so `resource` is treated as `audience`.
3. **Client registration**, pick one:
   - **A, Dynamic Client Registration**: Tenant Settings → Advanced → *OIDC Dynamic Application Registration*,
     and promote the Google + email connections to *domain level* so registered clients can use them.
   - **B, pre-registered client** (fastest for the spike): create a Regular Web App "Claude", callback
     `https://claude.ai/api/mcp/auth_callback`, and paste its client ID and secret in Claude's
     custom-connector *Advanced settings*.
4. **Post-Login Action**: when the requested audience is the MCP API, add the same claims the web ID token
   already carries to the **access token**:
   `https://papr.scope.com/sessionToken`, `https://papr.scope.com/objectId`, `https://papr.scope.com/email`.
   > Bridge only. PR 3 (memory) accepts the MCP access token directly and mints a scoped session, so the
   > Parse session stops riding in the token.

## Deploy (staging)

- Env on the Cloud App Host: `PAPR_MCP_ENABLED=1`, `PAPR_MCP_RESOURCE_URL=https://mcp.papr.ai/mcp`
  (optional `PAPR_MCP_AUDIENCE` if the Auth0 API identifier differs).
- Map `mcp.papr.ai` to the cloud-app-host Cloud Run service (same image).
- Check it: `curl https://mcp.papr.ai/.well-known/oauth-protected-resource/mcp` returns the metadata, and
  `curl -XPOST https://mcp.papr.ai/mcp` returns 401 with `WWW-Authenticate: Bearer resource_metadata=…`.

## Test script in Claude

1. Settings → Connectors → Add custom connector → `https://mcp.papr.ai/mcp` → Connect → sign in with Google.
2. In a chat: "Open my Papr app https://apps.papr.ai/{namespaceId}/{slug}".
3. Expect: card renders with app name, "Signed in as …", the table list and a round-trip time;
   **Open in Papr** opens apps.papr.ai.
4. Repeat in Cowork and Claude Desktop, in light and dark.

## Go / no-go to record in the PR

- [ ] claude.ai renders the card · [ ] Claude Desktop · [ ] Cowork
- [ ] `papr_api` callable from the card and **not** offered to the model
- [ ] Auth0 sign-in completes (A or B) · new Google user lands with a Papr session claim
- [ ] Tunnel round trip p50 under 400 ms
- [ ] Theme variables applied · `ui/open-link` works
