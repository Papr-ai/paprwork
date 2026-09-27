#!/usr/bin/env node
/**
 * Replay benchmark: Papr memory catalog injection — current (positional slice)
 * vs Jev-filtered (score each candidate against the user message, keep the
 * ones Jev says are likely to help).
 *
 * Measures, per replayed user turn:
 *   - catalog chars / est. tokens: old vs new
 *   - $ saved per turn at MODEL_PRICING input rates (Sonnet + Opus)
 *   - Jev latency + usage (cost of the filter itself)
 *   - recall: memoryIds the agent actually fetched on the NEXT assistant
 *     message (search_agent_memory({ memoryId })) — still present in the new block?
 *
 * Usage:
 *   npx tsx scripts/benchmark-jev-memory-catalog.mjs --turns=50
 *   npx tsx scripts/benchmark-jev-memory-catalog.mjs --turns=200 --min-score=2 --no-related
 *   npx tsx scripts/benchmark-jev-memory-catalog.mjs --db=/path/to/chats.db --json=out.json
 */

import { performance } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (k, d) => {
  const v = process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
  return v === undefined ? d : v;
};
const flag = (k) => process.argv.includes(`--${k}`);

const TURNS = Number(arg("turns", 50));
const MIN_SCORE = Number(arg("min-score", 2)); // GOAL_LEVELS index: 2 = "likely helps"
const MAX_KEEP = Number(arg("max-keep", 8));
const JEV_COST_PER_CALL = Number(arg("jev-cost-per-call", 0.0001));
const USE_RELATED = !flag("no-related");
const JSON_OUT = arg("json", null);

function defaultDb() {
  const root = path.join(os.homedir(), ".paprwork-v2", "orgs");
  const found = [];
  for (const org of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const nsRoot = path.join(root, org, "namespaces");
    if (!fs.existsSync(nsRoot)) continue;
    for (const ns of fs.readdirSync(nsRoot)) {
      const p = path.join(nsRoot, ns, "chats.db");
      if (fs.existsSync(p)) found.push(p);
    }
  }
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0];
}
const DB_PATH = arg("db", defaultDb());

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const estTokens = (s) => Math.ceil((s ?? "").length / 4);

async function main() {
  if (!DB_PATH) throw new Error("No chats.db found; pass --db=");
  // Read-only via the sqlite3 CLI (better-sqlite3 is not always installed in dev checkouts).
  const { execFileSync } = await import("node:child_process");
  const db = {
    prepare: (sql) => ({
      all: (limit) => {
        const out = execFileSync(
          "sqlite3",
          ["-json", `file:${DB_PATH}?mode=ro`, sql.replace("LIMIT ?", `LIMIT ${Number(limit)}`)],
          { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
        );
        return out.trim() ? JSON.parse(out) : [];
      },
    }),
    close: () => {},
  };

  const {
    buildPaprMemoryCatalogBlock,
    fetchPaprCatalogSnapshot,
    fetchMessageRelatedMemories,
    createPaprClientForCatalog,
  } = await import("../src/gateway/services/memoryGraphCatalog.js");
  const { GOAL_LEVELS } = await import("../src/core/tools/pageExtract.js");
  // Outside Electron, keyResolver has no IPC — allow a direct key for benchmarking.
  const benchKey = process.env.BENCH_PAPR_API_KEY?.trim();
  let evaluateJevWithAuth;
  if (benchKey) {
    const { evaluateJev } = await import("../src/core/tools/jevClient.js");
    const { JEV_PROXY_PATH } = await import("../src/core/tools/jevAuth.js");
    const base = process.env.PAPR_MEMORY_SERVER_URL?.trim() || "https://memory.papr.ai";
    const endpoint = process.env.TYPESAFE_API_KEY
      ? (process.env.TYPESAFE_SYSTEMONE_URL || "https://api.typesafe.ai/v1/systemone")
      : `${base}${JEV_PROXY_PATH}`;
    const apiKey = process.env.TYPESAFE_API_KEY || benchKey;
    const authHeader = process.env.TYPESAFE_API_KEY ? "bearer" : "x-api-key";
    evaluateJevWithAuth = (input) => evaluateJev({ ...input, endpoint, apiKey, authHeader });
    console.log(`jev endpoint: ${endpoint} (${authHeader})`);
  } else {
    ({ evaluateJevWithAuth } = await import("../src/core/tools/jevAuth.js"));
  }
  const { MODEL_PRICING } = await import("../src/gateway/services/CostCalculation.js");

  // --- sample turns: user msg + next assistant msg in same chat
  const rows = db
    .prepare(
      `SELECT u.id, u.chat_id, u.content, u.timestamp,
              (SELECT a.tool_calls FROM messages a
                 WHERE a.chat_id = u.chat_id AND a.role = 'assistant' AND a.timestamp > u.timestamp
                 ORDER BY a.timestamp ASC LIMIT 1) AS next_tool_calls
         FROM messages u
        WHERE u.role = 'user' AND length(u.content) BETWEEN 20 AND 2000
          AND u.content NOT LIKE '[%'
        ORDER BY u.timestamp DESC LIMIT ?`,
    )
    .all(TURNS);
  db.close();
  console.log(`db=${DB_PATH}\nturns=${rows.length} min-score=${MIN_SCORE} max-keep=${MAX_KEEP} related=${USE_RELATED}\n`);

  const usedIds = (toolCallsJson) => {
    const ids = new Set();
    if (!toolCallsJson) return ids;
    for (const m of toolCallsJson.matchAll(/memoryId\\?":\s*\\?"([0-9a-f-]{36})/g)) ids.add(m[1]);
    return ids;
  };

  // --- live tiers snapshot (same call the gateway makes)
  let papr = null;
  if (benchKey) {
    const { getPaprUserId } = await import("../src/gateway/utils/paprUserId.js");
    const userId = process.env.BENCH_PAPR_USER_ID?.trim() || getPaprUserId();
    const PaprClient = (await import("@papr/memory")).default;
    if (userId) papr = { userId, client: new PaprClient({ xAPIKey: benchKey, maxRetries: 1, timeout: 120_000 }) };
  } else {
    papr = await createPaprClientForCatalog();
  }
  if (!papr) throw new Error("PAPR_API_KEY / user id not resolvable — set BENCH_PAPR_API_KEY (and BENCH_PAPR_USER_ID) or run inside Paprwork");
  const t0 = performance.now();
  const snapCache = path.join(os.tmpdir(), `jev-bench-tiers-${papr.userId}.json`);
  let snap = null;
  if (!flag("refresh-tiers") && fs.existsSync(snapCache) && Date.now() - fs.statSync(snapCache).mtimeMs < 6 * 3600e3) {
    snap = JSON.parse(fs.readFileSync(snapCache, "utf8"));
  } else {
    snap = await fetchPaprCatalogSnapshot(papr.client, papr.userId);
    if (snap) fs.writeFileSync(snapCache, JSON.stringify(snap));
  }
  console.log(`tiers: tier0=${snap?.tier0.length ?? 0} tier1=${snap?.tier1.length ?? 0} (${Math.round(performance.now() - t0)}ms)\n`);
  if (flag("dump-tiers")) {
    for (const [t, arr] of [["t0", snap?.tier0 ?? []], ["t1", snap?.tier1 ?? []]])
      for (const m of arr) console.log(`  ${t} [${m.category ?? "-"}] ${(m.content ?? "").replace(/\s+/g, " ").slice(0, 140)}`);
    console.log();
  }
  const tier0 = snap?.tier0 ?? [];
  const tier1 = snap?.tier1 ?? [];

  const preview = (m) => (m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300);

  async function jevFilter(userMessage, memories) {
    const keyed = memories.map((m, i) => [`m${i}`, m]);
    const items = Object.fromEntries(keyed.map(([k, m]) => [k, `[${m.category ?? "memory"}] ${preview(m)}`]));
    const batches = [];
    const keys = Object.keys(items);
    for (let i = 0; i < keys.length; i += 12) batches.push(keys.slice(i, i + 12));
    let jevTokensIn = 0, jevTokensOut = 0, calls = 0;
    const scores = {};
    const start = performance.now();
    await Promise.all(
      batches.map(async (batch) => {
        const res = await evaluateJevWithAuth({
          state: { user_message: userMessage, memories: Object.fromEntries(batch.map((k) => [k, items[k]])) },
          questions: Object.fromEntries(
            batch.map((k) => [k, {
              type: "score",
              criteria: GOAL_LEVELS,
              instructions: `Would memory ${k} help answer or act on the user's message? Generic workspace facts unrelated to this message are "irrelevant".`,
            }]),
          ),
          timeoutMs: 20_000,
        });
        calls++;
        jevTokensIn += res.usage?.input_tokens ?? 0;
        jevTokensOut += res.usage?.output_tokens ?? 0;
        for (const k of batch) scores[k] = Number(res.answers[k]?.score ?? 0);
      }),
    );
    const ms = performance.now() - start;
    const kept = keyed
      .filter(([k]) => scores[k] >= MIN_SCORE)
      .sort((a, b) => scores[b[0]] - scores[a[0]])
      .slice(0, MAX_KEEP)
      .map(([, m]) => m);
    return { kept, ms, calls, jevTokensIn, jevTokensOut, scores: keyed.map(([k, m]) => [m.id, scores[k]]) };
  }

  const results = [];
  for (const [i, row] of rows.entries()) {
    const used = usedIds(row.next_tool_calls);
    let related = [];
    if (USE_RELATED) {
      try { related = await fetchMessageRelatedMemories(papr.client, papr.userId, row.content); } catch { related = []; }
    }
    const oldBlock = buildPaprMemoryCatalogBlock({ tier0, tier1, relatedMemories: related }) ?? "";

    // candidates = everything the old path could have shown, deduped
    const seen = new Set();
    const candidates = [...tier0, ...tier1, ...related].filter((m) => m.id && !seen.has(m.id) && seen.add(m.id));

    let jev;
    try { jev = await jevFilter(row.content, candidates); }
    catch (e) { console.error(`turn ${i}: jev failed: ${e.message}`); continue; }

    const keptIds = new Set(jev.kept.map((m) => m.id));
    const newBlock = buildPaprMemoryCatalogBlock({
      tier0: jev.kept.filter((m) => tier0.includes(m) || tier1.includes(m)),
      tier1: [],
      relatedMemories: jev.kept.filter((m) => !tier0.includes(m) && !tier1.includes(m)),
    }) ?? "";

    const usedInOld = [...used].filter((id) => oldBlock.includes(id));
    const usedInNew = usedInOld.filter((id) => keptIds.has(id));
    const r = {
      i, chat: row.chat_id.slice(0, 8), msg: row.content.slice(0, 70).replace(/\n/g, " "),
      candidates: candidates.length, kept: jev.kept.length,
      oldTokens: estTokens(oldBlock), newTokens: estTokens(newBlock),
      jevMs: Math.round(jev.ms), jevCalls: jev.calls, jevTokensIn: jev.jevTokensIn,
      usedInOld: usedInOld.length, usedInNew: usedInNew.length,
      scores: jev.scores,
    };
    results.push(r);
    if (flag("verbose")) {
      const top = [...jev.scores].sort((a, b) => b[1] - a[1]).slice(0, 5);
      for (const [id, s] of top) {
        const m = candidates.find((c) => c.id === id);
        console.log(`      ${s.toFixed(2)} [${m?.category ?? "-"}] ${preview(m ?? {}).slice(0, 110)}`);
      }
    }
    console.log(
      `${String(i).padStart(3)} ${r.chat} ${String(r.oldTokens).padStart(5)}→${String(r.newTokens).padStart(4)} tok ` +
      `keep ${String(r.kept).padStart(2)}/${String(r.candidates).padStart(2)} jev ${String(r.jevMs).padStart(5)}ms ` +
      `recall ${r.usedInNew}/${r.usedInOld}  ${r.msg}`,
    );
  }

  // --- summary
  const saved = results.map((r) => r.oldTokens - r.newTokens);
  const price = (id) => MODEL_PRICING[id]?.input ?? MODEL_PRICING[id]?.inputPerMillion ?? null;
  const perMTok = (id) => {
    const p = MODEL_PRICING[id]; if (!p) return null;
    return p.input ?? p.inputPerMillion ?? p.inputCostPerMillion ?? null;
  };
  const totalUsedOld = results.reduce((a, r) => a + r.usedInOld, 0);
  const totalUsedNew = results.reduce((a, r) => a + r.usedInNew, 0);
  const meanSaved = mean(saved);
  const jevCostPerTurn = mean(results.map((r) => r.jevCalls)) * JEV_COST_PER_CALL;

  console.log("\n=== SUMMARY ===");
  console.log(`turns scored:            ${results.length}`);
  console.log(`catalog tokens old/new:  ${Math.round(mean(results.map((r) => r.oldTokens)))} → ${Math.round(mean(results.map((r) => r.newTokens)))} (mean)`);
  console.log(`tokens saved / turn:     mean ${Math.round(meanSaved)}  p50 ${pct(saved, 50)}  p95 ${pct(saved, 95)}  (${Math.round((meanSaved / Math.max(1, mean(results.map((r) => r.oldTokens)))) * 100)}%)`);
  console.log(`kept / candidates:       ${mean(results.map((r) => r.kept)).toFixed(1)} / ${mean(results.map((r) => r.candidates)).toFixed(1)}`);
  console.log(`jev latency (ms):        mean ${Math.round(mean(results.map((r) => r.jevMs)))}  p50 ${pct(results.map((r) => r.jevMs), 50)}  p95 ${pct(results.map((r) => r.jevMs), 95)}`);
  console.log(`jev calls / turn:        ${mean(results.map((r) => r.jevCalls)).toFixed(1)}  (≈$${jevCostPerTurn.toFixed(5)}/turn at $${JEV_COST_PER_CALL}/call)`);
  console.log(`recall of used memories: ${totalUsedNew}/${totalUsedOld} ${totalUsedOld ? `(${Math.round((100 * totalUsedNew) / totalUsedOld)}%)` : "(no memoryId fetches in sampled turns — widen --turns)"}`);
  for (const id of ["claude-sonnet-4-6", "claude-opus-4-6", "gpt-5.5"]) {
    const p = perMTok(id);
    if (p == null) continue;
    const usd = (meanSaved / 1_000_000) * p; // uncached input price; cache reads would be 10% of this
    console.log(`$ saved / turn (${id}):  $${usd.toFixed(5)} uncached, $${(usd * 0.1).toFixed(5)} if cache-hit  → net $${(usd - jevCostPerTurn).toFixed(5)} / $${(usd * 0.1 - jevCostPerTurn).toFixed(5)}`);
  }
  console.log(`\nMODEL_PRICING keys sample: ${Object.keys(MODEL_PRICING).slice(0, 6).join(", ")}`);
  console.log(`price field shape: ${JSON.stringify(MODEL_PRICING[Object.keys(MODEL_PRICING)[0]])}`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ config: { TURNS, MIN_SCORE, MAX_KEEP, USE_RELATED, DB_PATH }, results }, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
