#!/usr/bin/env node
/**
 * Auth0 setup for the Claude-facing MCP endpoint (https://mcp.papr.ai/mcp).
 *
 * Dry run by default: reads the tenant, prints what it would change, changes nothing.
 *   node scripts/auth0-mcp-setup.mjs                  # dry run, steps api,resource,client
 *   node scripts/auth0-mcp-setup.mjs --apply          # apply steps api,resource,client
 *   node scripts/auth0-mcp-setup.mjs --steps=dcr      # launch-day: dynamic client registration (dry run)
 *
 * Steps
 *   api      Create the API (resource server) https://mcp.papr.ai/mcp, RS256, offline access.
 *   resource Tenant: resource_parameter_profile = "compatibility" (Claude sends resource=, not audience=).
 *   client   Create the "Claude (MCP connector)" web client with Claude's callback. Prints id + secret once.
 *   dcr      Tenant-wide: enable dynamic client registration + promote Google/email connections to
 *            domain level. Widens who can use your login. Separate, explicit opt-in.
 *
 * Also: --steps=list prints every application (Auth0 caps app count per plan; DCR clients count too).
 * Env: AUTH0_DOMAIN, AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET. Idempotent: re-running skips what exists.
 * Every run writes the tenant settings it read to auth0-backup-<ts>.json so changes can be undone.
 */
import { writeFileSync } from "node:fs";

const AUDIENCE = process.env.PAPR_MCP_AUDIENCE || "https://mcp.papr.ai/mcp";
const CLIENT_NAME = "Claude (MCP connector)";
const CALLBACKS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
const DOMAIN_CONNECTIONS = ["google-oauth2", "Username-Password-Authentication"];
const SCOPES = {
  list: ["read:clients"],
  api: ["read:resource_servers", "create:resource_servers"],
  resource: ["read:tenant_settings", "update:tenant_settings"],
  client: ["read:clients", "create:clients"],
  dcr: ["read:tenant_settings", "update:tenant_settings", "read:connections", "update:connections"],
};

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const steps = (args.find((a) => a.startsWith("--steps="))?.split("=")[1] ?? "api,resource,client").split(",");
const domain = (process.env.AUTH0_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
if (!domain || !process.env.AUTH0_MGMT_CLIENT_ID || !process.env.AUTH0_MGMT_CLIENT_SECRET) {
  console.error("Missing AUTH0_DOMAIN / AUTH0_MGMT_CLIENT_ID / AUTH0_MGMT_CLIENT_SECRET");
  process.exit(1);
}
const log = (tag, msg) => console.log(`${tag.padEnd(8)} ${msg}`);
const plan = (msg) => log(APPLY ? "APPLY" : "WOULD", msg);

async function token() {
  const r = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.AUTH0_MGMT_CLIENT_ID,
      client_secret: process.env.AUTH0_MGMT_CLIENT_SECRET,
      audience: `https://${domain}/api/v2/`,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`token: ${r.status} ${JSON.stringify(j)}`);
  return j.access_token;
}

const tok = await token();
const granted = new Set((JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()).scope || "").split(" "));
const missing = [...new Set(steps.flatMap((s) => SCOPES[s] ?? []))].filter((s) => !granted.has(s));
if (missing.length) {
  console.error(`Token is missing scopes: ${missing.join(", ")}\nAdd them under Applications → (this M2M app) → API Access → Auth0 Management API → Edit → Client Access.`);
  process.exit(2);
}
log("OK", `token for ${domain} has every scope these steps need (${steps.join(", ")})`);

async function api(method, path, body) {
  const r = await fetch(`https://${domain}/api/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return j;
}

const tenant = await api("GET", "/tenants/settings");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`auth0-backup-${stamp}.json`, JSON.stringify({ domain, tenant }, null, 2));
log("BACKUP", `tenant settings → auth0-backup-${stamp}.json`);

if (steps.includes("api")) {
  const all = await api("GET", "/resource-servers?per_page=100");
  const found = all.find((rs) => rs.identifier === AUDIENCE);
  if (found) log("SKIP", `API ${AUDIENCE} exists (id ${found.id}, ${found.signing_alg}, offline=${found.allow_offline_access})`);
  else {
    plan(`create API "Papr MCP" identifier=${AUDIENCE} RS256 offline_access=true`);
    if (APPLY) {
      const rs = await api("POST", "/resource-servers", {
        name: "Papr MCP", identifier: AUDIENCE, signing_alg: "RS256",
        allow_offline_access: true, skip_consent_for_verifiable_first_party_clients: true,
        token_lifetime: 86400,
      });
      log("DONE", `API created (id ${rs.id})`);
    }
  }
}

if (steps.includes("resource")) {
  const cur = tenant.resource_parameter_profile ?? "audience";
  if (cur === "compatibility") log("SKIP", "resource_parameter_profile is already compatibility");
  else {
    plan(`tenant resource_parameter_profile: ${cur} → compatibility`);
    if (APPLY) { await api("PATCH", "/tenants/settings", { resource_parameter_profile: "compatibility" }); log("DONE", "resource parameter compatibility on"); }
  }
}

if (steps.includes("list")) {
  const cs = await api("GET", "/clients?fields=client_id,name,app_type,callbacks,grant_types,is_first_party&include_fields=true&per_page=100");
  log("CLIENTS", `${cs.length} applications on this tenant`);
  for (const c of cs) console.log(`         ${(c.app_type || "-").padEnd(16)} ${c.name}  [${(c.callbacks || []).length} callbacks]`);
}

if (steps.includes("client")) {
  const clients = await api("GET", `/clients?fields=client_id,name,callbacks&include_fields=true&per_page=100`);
  const found = clients.find((c) => c.name === CLIENT_NAME);
  if (found) log("SKIP", `client "${CLIENT_NAME}" exists (client_id ${found.client_id}); secret is on its Credentials tab`);
  else {
    plan(`create web client "${CLIENT_NAME}" callbacks=${CALLBACKS.join(", ")} grants=authorization_code,refresh_token`);
    if (APPLY) {
      const c = await api("POST", "/clients", {
        name: CLIENT_NAME, app_type: "regular_web", callbacks: CALLBACKS,
        grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "client_secret_post",
        oidc_conformant: true, is_first_party: true,
        refresh_token: { rotation_type: "rotating", expiration_type: "expiring", token_lifetime: 2592000, infinite_token_lifetime: false, idle_token_lifetime: 1296000, infinite_idle_token_lifetime: false },
      });
      const f = `claude-client-${stamp}.json`; // the secret never goes to stdout/logs
      writeFileSync(f, JSON.stringify({ client_id: c.client_id, client_secret: c.client_secret }, null, 2), { mode: 0o600 });
      log("DONE", `client created: client_id ${c.client_id}. Secret written to ${f} (0600). Paste both into Claude → Add custom connector → Advanced.`);
    }
  }
}

if (steps.includes("dcr")) {
  if (tenant.flags?.enable_dynamic_client_registration) log("SKIP", "dynamic client registration already on");
  else {
    plan("tenant flags.enable_dynamic_client_registration → true (any client can self-register)");
    if (APPLY) { await api("PATCH", "/tenants/settings", { flags: { enable_dynamic_client_registration: true } }); log("DONE", "DCR on"); }
  }
  const conns = await api("GET", "/connections?per_page=100&strategy=google-oauth2&strategy=auth0");
  for (const name of DOMAIN_CONNECTIONS) {
    const c = conns.find((x) => x.name === name);
    if (!c) { log("WARN", `connection ${name} not found`); continue; }
    if (c.is_domain_connection) { log("SKIP", `${name} is already domain-level`); continue; }
    plan(`connection ${name} → domain-level`);
    if (APPLY) { await api("PATCH", `/connections/${c.id}`, { is_domain_connection: true }); log("DONE", `${name} is domain-level`); }
  }
}

if (!APPLY) console.log("\nDry run. Nothing changed. Re-run with --apply to make these changes.");
