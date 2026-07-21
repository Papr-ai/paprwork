#!/usr/bin/env node
/**
 * Diagnose a single cloud agent job end-to-end using the running Paprwork gateway.
 * Uses WebSocket jobs:run (runtime=cloud) so the correct PAPR_API_KEY from keychain is used.
 *
 * Usage:
 *   node scripts/diagnose-cloud-agent-job.mjs
 *   node scripts/diagnose-cloud-agent-job.mjs --job-id=2cafb2e9-696b-42db-98fa-5d605977123c
 *   node scripts/diagnose-cloud-agent-job.mjs --preflight-only
 */

import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const jobId =
  args.find((a) => a.startsWith("--job-id="))?.split("=")[1] ??
  "2cafb2e9-696b-42db-98fa-5d605977123c";
const preflightOnly = args.includes("--preflight-only");
const gatewayHttp =
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  "http://localhost:18789";
const wsUrl = gatewayHttp.replace(/^http/, "ws") + "/";

const PROVIDER_KEYS = {
  openai: "OPENAI_API_KEY",
  "openai-codex": "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

function log(section, msg) {
  console.log(`[${section}] ${msg}`);
}

async function httpGet(path) {
  const res = await fetch(`${gatewayHttp}${path}`);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function preflight() {
  log("preflight", `jobId=${jobId}`);

  const health = await httpGet("/health").catch(() => ({ status: 0 }));
  log("preflight", `gateway health: ${health.status || "unreachable"}`);

  const vault = await httpGet("/api/cloud/vault/keys?scope=user");
  if (vault.status !== 200) {
    log("preflight", `vault list failed: ${vault.status} ${JSON.stringify(vault.data).slice(0, 200)}`);
    return { ok: false };
  }
  const vaultNames = new Set((vault.data.keys ?? []).map((k) => k.name));
  log("preflight", `vault keys: ${vaultNames.size}`);

  const jobsList = await wsRequest("jobs:list", {}, 30_000);
  const jobs = Array.isArray(jobsList) ? jobsList : jobsList?.jobs ?? [];
  const job = jobs.find((j) => j.id === jobId);
  if (!job) {
    log("preflight", `job not found locally: ${jobId}`);
    return { ok: false };
  }

  const provider = (job.provider ?? "").toLowerCase() || null;
  const llmKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
  const availableLlmKeys = llmKeys.filter((k) => vaultNames.has(k));
  const requiredKey = provider
    ? (PROVIDER_KEYS[provider] ?? "OPENAI_API_KEY")
    : availableLlmKeys[0] ?? "OPENAI_API_KEY";
  const hasKey = provider
    ? vaultNames.has(requiredKey)
    : availableLlmKeys.length > 0;

  log(
    "preflight",
    `job: ${job.name} type=${job.type} provider=${provider ?? "(auto from vault)"} model=${job.model ?? "(default)"}`,
  );
  if (provider) {
    log("preflight", `required vault key: ${requiredKey} → ${hasKey ? "present" : "MISSING"}`);
  } else {
    log(
      "preflight",
      `vault LLM keys: ${availableLlmKeys.length ? availableLlmKeys.join(", ") : "NONE"}`,
    );
  }

  if (job.type !== "agent" && job.type !== "subagent") {
    log("preflight", `not an agent job — pick an agent/subagent job`);
    return { ok: false, job };
  }

  if (!hasKey) {
    log(
      "preflight",
      provider
        ? `fix: add ${requiredKey} in Settings → API Keys, or set job provider to one you have`
        : "fix: add OPENAI_API_KEY or ANTHROPIC_API_KEY in Settings → API Keys",
    );
    return { ok: false, job, requiredKey };
  }

  return { ok: true, job, provider: provider ?? "auto", requiredKey };
}

const CLOUD_AGENT_JOB_TIMEOUT_MS = 1_800_000; // 30 minutes — matches CloudJobRunService

function wsRequest(type, payload, timeoutMs = CLOUD_AGENT_JOB_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WebSocket timeout after ${timeoutMs}ms (${type})`));
    }, timeoutMs);

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on("open", () => {
      ws.send(JSON.stringify({ id, type, payload }));
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (!msg.success) {
        reject(new Error(msg.error ?? "WebSocket request failed"));
        return;
      }
      resolve(msg.data);
    });
  });
}

async function runCloudJob() {
  log("run", "starting cloud run via jobs:run (runtime=cloud) — may take up to 30 min for agent jobs");
  const t0 = Date.now();
  const result = await wsRequest("jobs:run", { jobId, runtime: "cloud" });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log("run", `finished in ${elapsed}s status=${result.status} exitCode=${result.exitCode ?? result.exit_code ?? "?"}`);
  if (result.error) log("run", `error: ${String(result.error).slice(0, 500)}`);
  const out = result.lastOutput ?? result.last_output ?? "";
  if (out) log("run", `output preview:\n${String(out).slice(0, 1200)}`);
  return result;
}

async function main() {
  console.log("\n=== Cloud Agent Job Diagnostic ===\n");
  const check = await preflight();
  if (!check.ok) {
    process.exit(1);
  }
  if (preflightOnly) {
    log("done", "preflight passed");
    return;
  }
  try {
    await runCloudJob();
    log("done", "cloud run completed — check job logs and GitHub writeback");
  } catch (err) {
    log("fail", (err).message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
