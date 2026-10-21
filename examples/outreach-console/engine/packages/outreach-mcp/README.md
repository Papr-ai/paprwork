# Outreach MCP (local stdio)

Stage 1 control surface. Requires Node 22.13+ and an initialized engine database.
Run `outreach init --db /absolute/path/outreach.db` as the local OS user first.
Then configure the host to launch:

```json
{"mcpServers":{"outreach":{"command":"outreach-mcp","args":["--db","/absolute/path/outreach.db","--workspace","default"]}}}
```

Development: use `node packages/outreach-mcp/dist/bin.js` after `npm run build`.
There is no TCP listener, OAuth grant, provider config loading, worker execution,
or access to provider secrets. Local identity is the existing `cli:<OS username>`
principal, resolved on every call. Unknown principals are denied.

Exactly ten tools implement BUILD_PLAN §11.3. Import accepts inline text only
(CSV/JSON/HTML, 1 MB); use the CLI for XLSX or larger files. Mapping profiles,
templates and draft campaigns must already exist. Sequence preview validates
structure and checks workspace resources; the standalone MCP process has no
provider adapters, so it explicitly reports provider capability/purpose validation as unverified,
not as a valid executable sequence. Run full compilation through the configured CLI before activation.

Pause, manual-task completion, imports and activation use a durable two-phase
operation bound to the workspace, principal, exact payload/hash and a 15-minute
expiry. `outreach_commit` requires human approval through MCP form elicitation;
clients without that capability can preview but cannot commit. No model-provided
`confirmed` argument is accepted. An embedding host may supply its own trusted
confirmation callback, but must show the stored preview and ask the actual human.
Commit rechecks identity, role, expiry and hash after confirmation, and fails
closed if the domain operation is stale. An operation commits at most once.
Campaign approvals are still separate and must be decided in the CLI or HTTP UI.

Contact and reply-derived fields are wrapped as untrusted data. They never grant
authorization. Do not auto-approve these tools in a host. A manual outcome means a
human reports work already performed; this server never visits LinkedIn.

Remote Stage 2 is deliberately not exposed. Papr Auth0 API/audience registration
(or a separately approved tenant), HTTPS hosting, OAuth protected-resource
metadata, token audience/issuer validation and real ChatGPT acceptance remain
external design/acceptance work. There is no placeholder auth bypass.

The standalone process also has no unsubscribe signing configuration. Activation
or manual-task progression that would freeze a link-based email (or a template
using `unsubscribe_url`) therefore fails closed without changing campaign/task
state. Commit those operations through the configured CLI/API. It will not quietly
replace a link with a reply-only footer. A host embedding the server may provide
a fully configured engine, subject to the same confirmation and policy gates.
