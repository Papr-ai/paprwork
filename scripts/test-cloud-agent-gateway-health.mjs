#!/usr/bin/env node
/**
 * Smoke test Cloud Agent Gateway health (local or deployed).
 *
 * Usage:
 *   PAPR_CLOUD_AGENT_GATEWAY_KEY=xxx node scripts/test-cloud-agent-gateway-health.mjs
 *   node scripts/test-cloud-agent-gateway-health.mjs --url=https://YOUR.run.app
 */

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith("--url="));
const base = (urlArg ? urlArg.slice(6) : process.env.CLOUD_AGENT_GATEWAY_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const key = process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY ?? "";

if (!key) {
  console.error("Set PAPR_CLOUD_AGENT_GATEWAY_KEY");
  process.exit(1);
}

const resp = await fetch(`${base}/health`, {
  headers: { "X-Cloud-Agent-Gateway-Key": key },
});

if (!resp.ok) {
  console.error(`Health failed: ${resp.status} ${await resp.text()}`);
  process.exit(1);
}

const body = await resp.json();
console.log("OK:", JSON.stringify(body));
if (body.mode !== "cloud_agent") {
  console.error("Expected mode=cloud_agent, got", body.mode);
  process.exit(1);
}
