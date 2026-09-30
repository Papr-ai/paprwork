#!/usr/bin/env node
/**
 * End-to-end latency breakdown for Jev, Papr memory catalog, and LLM proxy hops.
 *
 * Requires credentials (no Electron IPC):
 *   export BENCH_PAPR_API_KEY='sk-org-...'
 *   export BENCH_PAPR_USER_ID='...'   # optional if getPaprUserId() works
 *
 * Optional:
 *   PAPR_MEMORY_SERVER_URL  (default https://memory.papr.ai)
 *   TYPESAFE_API_KEY        — benchmark direct TypeSafe instead of Papr proxy
 *   --iterations=5
 *   --include-llm           — one mini chat completion (uses Papr credits)
 *   --include-turn2         — sync tiers + related search + catalog Jev gate
 *   --message='...'         — user message for turn-2 simulation
 *
 * Server-side phases (auth / limits / upstream) appear when memory returns
 * X-Papr-Proxy-Timing (deploy memory repo with proxy_request_timing.py).
 *
 * Usage:
 *   node --import tsx scripts/benchmark-jev-llm-latency.mjs
 *   npm run benchmark:jev-latency
 */

import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const arg = (k, d) => {
  const v = process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
  return v === undefined ? d : v;
};
const flag = (k) => process.argv.includes(`--${k}`);

const ITER = Math.max(1, Number(arg("iterations", 3)));
const INCLUDE_LLM = flag("include-llm");
const INCLUDE_TURN2 = flag("include-turn2");
const SAMPLE_MESSAGE =
  arg("message", "Summarize my open tasks for this week and suggest what to do first.") ??
  "Summarize my open tasks for this week and suggest what to do first.";

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function parseServerTiming(headers) {
  const raw = headers.get("x-papr-proxy-timing") ?? headers.get("X-Papr-Proxy-Timing");
  if (!raw) return null;
  const out = {};
  for (const part of raw.split(",")) {
    const [k, v] = part.trim().split("=");
    if (k && v) out[k] = Number(v);
  }
  return out;
}

async function timed(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  return { label, ms: performance.now() - t0, result };
}

function recordPhase(stats, name, ms, serverTiming = null) {
  if (!stats[name]) stats[name] = [];
  stats[name].push(ms);
  if (serverTiming) {
    for (const [k, v] of Object.entries(serverTiming)) {
      const key = `server:${k}`;
      if (!stats[key]) stats[key] = [];
      stats[key].push(v);
    }
  }
}

async function resolveBenchKey() {
  const { loadEnvLocal, resolvePaprApiKey } = await import("./lib/testEnv.mjs");
  loadEnvLocal();
  const benchOverride = process.env.BENCH_PAPR_API_KEY?.trim();
  if (benchOverride) return benchOverride;
  const resolved = await resolvePaprApiKey();
  if (resolved) {
    console.log(`(Papr API key from ${resolved.source})\n`);
    return resolved.key;
  }
  return null;
}

async function setupJev() {
  const benchKey = await resolveBenchKey();
  const { JEV_PROXY_PATH } = await import("../src/core/tools/jevAuth.js");
  const base = (process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai").replace(/\/$/, "");
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    return {
      mode: "typesafe_byok",
      endpoint: process.env.TYPESAFE_SYSTEMONE_URL?.trim() || "https://api.typesafe.ai/v1/systemone",
      apiKey: process.env.TYPESAFE_API_KEY.trim(),
      authHeader: "bearer",
      memoryBase: base,
      benchKey: benchKey ?? null,
    };
  }
  if (!benchKey) {
    throw new Error(
      "No Papr API key: set BENCH_PAPR_API_KEY or PAPR_API_KEY in .env.local, " +
        "or log in via Papr Work (dev Electron often cannot read keys encrypted by the installed app). " +
        "Or set TYPESAFE_API_KEY for direct TypeSafe.",
    );
  }
  return {
    mode: "papr_proxy",
    endpoint: `${base}${JEV_PROXY_PATH}`,
    apiKey: benchKey,
    authHeader: "x-api-key",
    memoryBase: base,
    benchKey,
  };
}

function minimalJevBody() {
  return {
    model: "jev-latest",
    state: "User asked whether to prioritize email or calendar prep for a 9am meeting.",
    questions: {
      focus: {
        type: "choice",
        instructions: "Which workstream should come first?",
        criteria: { email: "Clear inbox first", calendar: "Review agenda first" },
      },
    },
  };
}

function catalogBatchBody(userMessage, batchKeys, items) {
  return {
    model: "jev-latest",
    state: { user_message: userMessage, memories: Object.fromEntries(batchKeys.map((k) => [k, items[k]])) },
    questions: Object.fromEntries(
      batchKeys.map((k) => [
        k,
        {
          type: "score",
          criteria: ["irrelevant", "on topic", "likely helps", "essential"],
          instructions: `Would memory ${k} help answer the user's message?`,
        },
      ]),
    ),
  };
}

async function postJev(cfg, body, stats, phaseName) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.authHeader === "x-api-key") headers["X-API-Key"] = cfg.apiKey;
  else headers.Authorization = `Bearer ${cfg.apiKey}`;

  const t0 = performance.now();
  const res = await fetch(cfg.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const wallMs = performance.now() - t0;
  const serverTiming = parseServerTiming(res.headers);
  recordPhase(stats, phaseName, wallMs, serverTiming);

  if (!res.ok) {
    throw new Error(`${phaseName} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

async function main() {
  const cfg = await setupJev();
  const stats = {};

  console.log("=== Paprwork Jev / LLM latency benchmark ===");
  console.log(`mode=${cfg.mode} endpoint=${cfg.endpoint}`);
  console.log(`iterations=${ITER} include-llm=${INCLUDE_LLM} include-turn2=${INCLUDE_TURN2}\n`);

  // --- Health / RTT ---
  for (let i = 0; i < ITER; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch(`${cfg.memoryBase}/health`, { method: "GET" });
      await r.text();
      recordPhase(stats, "memory_health_rtt", performance.now() - t0);
    } catch {
      recordPhase(stats, "memory_health_rtt", performance.now() - t0);
    }
  }

  // --- Minimal Jev (tool-shaped) ---
  for (let i = 0; i < ITER; i++) {
    await postJev(cfg, minimalJevBody(), stats, "jev_minimal_call");
  }

  // --- Catalog-shaped batch (12 score questions) ---
  const batchItems = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `m${i}`,
      `[memory] Sample tier item ${i}: context about project alpha and deadline ${i + 3}.`,
    ]),
  );
  for (let i = 0; i < ITER; i++) {
    await postJev(
      cfg,
      catalogBatchBody(SAMPLE_MESSAGE, Object.keys(batchItems), batchItems),
      stats,
      "jev_catalog_one_batch",
    );
  }

  // --- Turn-2 simulation (Papr API + optional Jev gate) ---
  if (INCLUDE_TURN2 && cfg.benchKey) {
    const { getPaprUserId } = await import("../src/gateway/utils/paprUserId.js");
    const {
      fetchPaprCatalogSnapshot,
      fetchMessageRelatedMemories,
    } = await import("../src/gateway/services/memoryGraphCatalog.js");
    const { gateCatalogWithJev } = await import("../src/gateway/services/jevMemoryCatalogGate.js");
    const Papr = (await import("@papr/memory")).default;
    const userId = process.env.BENCH_PAPR_USER_ID?.trim() || getPaprUserId();
    if (!userId) {
      console.warn("skip turn2: no BENCH_PAPR_USER_ID / papr user id");
    } else {
      const client = new Papr({ xAPIKey: cfg.benchKey, maxRetries: 1, timeout: 120_000 });
      for (let i = 0; i < Math.min(ITER, 2); i++) {
        const snapT = await timed("tiers", () => fetchPaprCatalogSnapshot(client, userId));
        recordPhase(stats, "turn2_sync_tiers", snapT.ms);
        const relT = await timed("related", () =>
          fetchMessageRelatedMemories(client, userId, SAMPLE_MESSAGE),
        );
        recordPhase(stats, "turn2_message_search", relT.ms);
        const candidates = [
          ...(snapT.result?.tier0 ?? []),
          ...(snapT.result?.tier1 ?? []),
          ...(relT.result ?? []),
        ].slice(0, 40);
        const gateT = await timed("gate", () => gateCatalogWithJev(SAMPLE_MESSAGE, candidates));
        recordPhase(stats, "turn2_jev_catalog_gate", gateT.ms);
        if (gateT.result?.jevCalls != null) {
          recordPhase(stats, "turn2_jev_catalog_calls", gateT.result.jevCalls);
        }
      }
    }
  }

  // --- LLM proxy mini completion (optional, bills credits) ---
  if (INCLUDE_LLM && cfg.benchKey && cfg.mode === "papr_proxy") {
    const url = `${cfg.memoryBase}/v1/ai/openai/chat/completions`;
    const body = {
      model: "gpt-4o-mini",
      max_tokens: 5,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      stream: false,
    };
    for (let i = 0; i < Math.min(ITER, 2); i++) {
      const t0 = performance.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": cfg.benchKey },
        body: JSON.stringify(body),
      });
      await res.text();
      recordPhase(stats, "llm_proxy_mini_completion", performance.now() - t0, parseServerTiming(res.headers));
    }
  }

  // --- Report ---
  const rows = Object.entries(stats)
    .map(([name, values]) => ({
      name,
      n: values.length,
      p50: pct(values, 50),
      p95: pct(values, 95),
      mean: mean(values),
    }))
    .sort((a, b) => b.mean - a.mean);

  console.log("Phase                          n     p50(ms)  p95(ms)  mean(ms)");
  console.log("─".repeat(72));
  for (const r of rows) {
    const pad = r.name.padEnd(30);
    console.log(
      `${pad} ${String(r.n).padStart(3)}  ${r.p50.toFixed(1).padStart(8)}  ${r.p95.toFixed(1).padStart(8)}  ${r.mean.toFixed(1).padStart(8)}`,
    );
  }

  const top = rows[0];
  if (top) {
    console.log(`\nLargest mean contributor: ${top.name} (~${top.mean.toFixed(0)}ms)`);
    const serverRows = rows.filter((r) => r.name.startsWith("server:"));
    if (serverRows.length) {
      console.log("\nServer-reported sub-phases (from X-Papr-Proxy-Timing, when deployed):");
      for (const r of serverRows.sort((a, b) => b.mean - a.mean)) {
        console.log(`  ${r.name.replace("server:", "")}: mean ${r.mean.toFixed(1)}ms`);
      }
    } else {
      console.log(
        "\nNo X-Papr-Proxy-Timing yet — deploy memory server timing headers to split auth/limits/upstream.",
      );
    }
  }

  const outPath = arg("json", null);
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ cfg: { mode: cfg.mode, endpoint: cfg.endpoint }, rows }, null, 2));
    console.log(`\nWrote ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
