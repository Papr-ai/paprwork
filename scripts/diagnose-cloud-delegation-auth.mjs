#!/usr/bin/env node
/**
 * Compare Papr Web main-chat auth (llmAuth + authOverride) vs Product Architect
 * delegation auth (getProviderAuth on cloud gateway — no parent llmAuth).
 *
 * Does NOT print full secrets — only prefix, length, authType, and API probe status.
 *
 * Usage:
 *   node --import tsx scripts/diagnose-cloud-delegation-auth.mjs
 *   node --import tsx scripts/diagnose-cloud-delegation-auth.mjs --probe-platform-api
 *   node --import tsx scripts/diagnose-cloud-delegation-auth.mjs --gateway=http://127.0.0.1:8788
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const probePlatform = args.includes("--probe-platform-api");
const gatewayArg = args.find((a) => a.startsWith("--gateway="));
const gatewayBase = (
  gatewayArg?.split("=")[1] ??
  process.env.CLOUD_AGENT_GATEWAY_URL ??
  "http://127.0.0.1:8788"
).replace(/\/$/, "");

function loadEnvLocal() {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function describeToken(token) {
  const t = token.trim();
  if (!t) return { present: false };
  let kind = "unknown";
  if (t.startsWith("sk-ant-oat") || t.startsWith("sk-ant-ort")) kind = "anthropic-oauth-shaped";
  else if (t.startsWith("sk-ant-api")) kind = "anthropic-platform-api";
  else if (t.startsWith("sk-ant-")) kind = "anthropic-other-sk-ant";
  return {
    present: true,
    length: t.length,
    prefix: t.slice(0, 16) + "…",
    kind,
  };
}

async function probeAnthropicPlatformApi(token) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK" }],
    }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

async function main() {
  loadEnvLocal();
  process.env.GATEWAY_MODE = "cloud_agent";

  const token = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  const meta = describeToken(token);

  console.log("\n=== Cloud delegation vs main-chat auth (local simulation) ===\n");
  console.log("GATEWAY_MODE:", process.env.GATEWAY_MODE);
  console.log("ANTHROPIC_API_KEY:", meta.present ? meta : "MISSING");

  if (!meta.present) {
    console.error("\nSet ANTHROPIC_API_KEY in .env.local (or env) to match vault/desktop.");
    process.exit(1);
  }

  const { resolveVaultKeySource, reconcileCloudProviderAuth } = await import(
    "../src/gateway/services/cloudAgentGateway/resolveCloudProviderAuth.ts"
  );
  const { getProviderAuth } = await import("../src/gateway/utils/keyResolver.ts");

  const vaultSource = resolveVaultKeySource(
    {
      name: "ANTHROPIC_API_KEY",
      source: "oauth",
      managedBy: "oauth",
      oauthProvider: "anthropic",
      description: "Claude Pro/Max OAuth Token (Auto-managed)",
    },
    token,
  );

  const mainPath = reconcileCloudProviderAuth({
    provider: "anthropic",
    token,
    authType: token.startsWith("sk-ant-oat") ? "oauth" : "apiKey",
  });

  // Cloud sandbox: vault injects env; no Electron IPC (process.send absent).
  delete process.env.OPENAI_API_KEY;
  const delegationAuth = await getProviderAuth("anthropic");

  console.log("\n--- Path comparison (Product Architect uses delegation column) ---");
  console.log("vault papr-source label (if synced):", vaultSource);
  console.log("Main web turn (memory llmAuth → authOverride):");
  console.log("  authType:", mainPath.authType);
  console.log("  provider:", mainPath.provider);
  console.log("Delegation subagent (getProviderAuth, no authOverride):");
  console.log(
    "  authType:",
    delegationAuth?.type ?? "null (no auth — would fallback/fail)",
  );
  console.log("  has IPC (Electron):", typeof process.send === "function");

  const mismatch =
    mainPath.authType === "oauth" &&
    delegationAuth?.type === "apiKey" &&
    meta.kind === "anthropic-oauth-shaped";

  if (mismatch) {
    console.log("\n⚠️  LIKELY ROOT CAUSE: same OAuth token, but delegation uses authType=apiKey");
    console.log("    → Platform API route (401 → UI says “Invalid API key in Settings”).");
    console.log("    Main chat uses authType=oauth → pi-ai subscription route.");
  } else if (!delegationAuth) {
    console.log("\n⚠️  Delegation path found no auth (vault not in process.env on cloud?).");
  } else if (mainPath.authType === delegationAuth.type) {
    console.log("\n✓ authType matches between paths — if failures persist, probe model/access next.");
  }

  if (probePlatform) {
    console.log("\n--- Platform API probe (claude-opus-4-6, x-api-key header) ---");
    console.log("(OAuth tokens usually return 401 here even when Claude OAuth works in app.)");
    try {
      const probe = await probeAnthropicPlatformApi(token);
      const errType = probe.body?.error?.type ?? probe.body?.type;
      const errMsg = probe.body?.error?.message ?? probe.body?.message ?? "";
      console.log("HTTP status:", probe.status);
      console.log("error type:", errType ?? "(none)");
      console.log("message:", String(errMsg).slice(0, 200));
      if (probe.status === 401 && meta.kind === "anthropic-oauth-shaped") {
        console.log(
          "\n→ 401 with OAuth-shaped token on Platform API is EXPECTED; not proof the subscription is dead.",
        );
      }
    } catch (err) {
      console.log("probe failed:", err.message);
    }
  } else {
    console.log("\n(Add --probe-platform-api to hit api.anthropic.com once with this token.)");
  }

  const gatewayKey = process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY?.trim();
  if (gatewayKey) {
    console.log("\n--- Cloud Agent Gateway health ---");
    try {
      const res = await fetch(`${gatewayBase}/health`, {
        headers: { "X-Cloud-Agent-Gateway-Key": gatewayKey },
      });
      const body = await res.json().catch(() => ({}));
      console.log(`${gatewayBase}/health → ${res.status}`, JSON.stringify(body));
    } catch (err) {
      console.log(`Gateway unreachable at ${gatewayBase}:`, err.message);
      console.log("Start locally: npm run start:cloud-agent-gateway");
    }
  } else {
    console.log("\n(Set PAPR_CLOUD_AGENT_GATEWAY_KEY to probe deployed/local cloud agent gateway.)");
  }

  console.log("\n--- Next: live delegation on desktop gateway (uses cloud runtime) ---");
  console.log(
    "  node scripts/diagnose-cloud-agent-job.mjs --preflight-only",
  );
  console.log(
    "  Then create a subagent job or use jobs:run runtime=cloud on a Delegation: Product Architect job.",
  );
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
