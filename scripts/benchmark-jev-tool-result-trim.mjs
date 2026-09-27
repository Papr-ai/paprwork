#!/usr/bin/env node
/**
 * Replay benchmark: stale tool-result compaction — head+tail (current) vs
 * Jev-selected chunks at the same char budget.
 *
 * Why: get_full_tool_result is the #2 tool by volume (3.8k calls / 30d).
 * 2.6k of those page back a *bash* result whose p50 full size is ~1.3k chars
 * — it was compacted to 400 chars (head+tail) after 3 more tool steps, and
 * the agent needed something from the middle. Every page-back is a full
 * context re-send.
 *
 * Ground truth per fetch: tokens (paths, identifiers, numbers ≥6 chars) in
 * the agent's NEXT tool call args that also appear in the full result. An
 * excerpt that contains them would likely have made the fetch unnecessary.
 *
 * Usage:
 *   npx tsx scripts/benchmark-jev-tool-result-trim.mjs --n=60 --budget=400
 *   npx tsx scripts/benchmark-jev-tool-result-trim.mjs --n=60 --budget=2000 --json=out.json
 */
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (k, d) => {
  const v = process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
  return v === undefined ? d : v;
};
const N = Number(arg("n", 60));
const BUDGET = Number(arg("budget", 400));
const CHUNK = Number(arg("chunk", 240));
const BATCH = Number(arg("batch", 16));
const MIN_LEVEL = Number(arg("min-level", 1)); // GOAL_LEVELS: 1 = "related"
const JSON_OUT = arg("json", null);
const VERBOSE = process.argv.includes("--verbose");

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
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);

/** Ground-truth tokens: things the agent typed next that it could only have learned from the result. */
function groundTruthTokens(nextArgs, fullResult, userMsg, cmd) {
  const text = JSON.stringify(nextArgs ?? {});
  const toks = new Set(text.match(/[A-Za-z0-9_./:-]{6,}/g) ?? []);
  const exclude = `${userMsg}\n${cmd}`;
  return [...toks].filter((t) => fullResult.includes(t) && !exclude.includes(t));
}

function chunkLines(s) {
  const out = [];
  let cur = "";
  for (const line of s.split("\n")) {
    if (cur.length + line.length + 1 > CHUNK && cur) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) out.push(cur);
  return out;
}

function assemble(chunks, scores, budget) {
  const order = chunks.map((c, i) => [i, scores[i] ?? 0]).filter(([, s]) => s >= MIN_LEVEL).sort((a, b) => b[1] - a[1]);
  const picked = [];
  let used = 0;
  for (const [i] of order) {
    if (used + chunks[i].length + 12 > budget) continue;
    picked.push(i);
    used += chunks[i].length + 12;
  }
  picked.sort((a, b) => a - b);
  return picked.map((i) => chunks[i]).join("\n[…]\n");
}

async function main() {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const { truncateToCharLimit } = await import("../src/gateway/services/agent/toolResultTruncation.js");
  const { GOAL_LEVELS } = await import("../src/core/tools/pageExtract.js");
  const { evaluateJevWithAuth } = await import("../src/core/tools/jevAuth.js");

  const rows = db
    .prepare(
      `SELECT a.tool_calls, a.chat_id,
              (SELECT u.content FROM messages u WHERE u.chat_id=a.chat_id AND u.role='user' AND u.timestamp<a.timestamp ORDER BY u.timestamp DESC LIMIT 1) AS user_msg
         FROM messages a
        WHERE a.role='assistant' AND a.tool_calls LIKE '%get_full_tool_result%'
          AND a.chat_id NOT LIKE 'job:%'
        ORDER BY a.timestamp DESC LIMIT 600`,
    )
    .all();
  db.close();

  const cases = [];
  for (const r of rows) {
    let calls;
    try { calls = JSON.parse(r.tool_calls); } catch { continue; }
    const byId = new Map(calls.map((c) => [c.id, c]));
    for (let i = 0; i < calls.length && cases.length < N; i++) {
      const c = calls[i];
      if (c.name !== "get_full_tool_result") continue;
      const tgt = byId.get(c.args?.toolCallId);
      const next = calls[i + 1];
      if (!tgt || tgt.name !== "bash" || typeof tgt.result !== "string") continue;
      if (!next || next.name === "get_full_tool_result") continue;
      if (tgt.result.length <= BUDGET || tgt.result.length > 60_000) continue;
      const gt = groundTruthTokens(next.args, tgt.result, r.user_msg ?? "", tgt.args?.command ?? "");
      if (gt.length === 0) continue;
      cases.push({ chat: r.chat_id.slice(0, 8), userMsg: r.user_msg ?? "", cmd: tgt.args?.command ?? "", full: tgt.result, toolCallId: tgt.id, gt });
    }
    if (cases.length >= N) break;
  }
  console.log(`db=${DB_PATH}\ncases=${cases.length} budget=${BUDGET} chunk=${CHUNK} min-level=${MIN_LEVEL}\n`);

  const results = [];
  for (const [i, cs] of cases.entries()) {
    const baseline = truncateToCharLimit(cs.full, BUDGET, cs.toolCallId, "bash");
    const chunks = chunkLines(cs.full);
    const goal = `User asked: ${cs.userMsg.slice(0, 600)}\nAgent ran this command to make progress: ${cs.cmd.slice(0, 600)}`;

    const t0 = performance.now();
    const scores = [];
    let calls = 0;
    let err = null;
    try {
      for (let b = 0; b < chunks.length; b += BATCH) {
        const batch = chunks.slice(b, b + BATCH);
        const items = Object.fromEntries(batch.map((c, k) => [`c${b + k}`, c]));
        const res = await evaluateJevWithAuth({
          state: { goal, output_chunks: items },
          questions: Object.fromEntries(
            Object.keys(items).map((k) => [k, {
              type: "score",
              criteria: GOAL_LEVELS,
              instructions: `The agent will need to look back at this command output later. How useful is chunk ${k} for the goal — does it contain the specific facts (paths, names, values, errors) the agent would act on? Boilerplate, headers and repeated noise are "irrelevant".`,
            }]),
          ),
          timeoutMs: 20_000,
        });
        calls++;
        for (const k of Object.keys(items)) scores[Number(k.slice(1))] = Number(res.answers[k]?.score ?? 0);
      }
    } catch (e) { err = e.message; }
    const jevMs = Math.round(performance.now() - t0);
    if (err) { console.error(`${i} jev failed: ${err}`); continue; }

    const jev = assemble(chunks, scores, BUDGET);
    const hit = (ex) => cs.gt.filter((t) => ex.includes(t)).length;
    const r = {
      i, chat: cs.chat, fullChars: cs.full.length, chunks: chunks.length, gt: cs.gt.length,
      baseHit: hit(baseline), jevHit: hit(jev), jevChars: jev.length, jevMs, calls,
      baseAll: hit(baseline) === cs.gt.length, jevAll: hit(jev) === cs.gt.length,
    };
    results.push(r);
    console.log(
      `${String(i).padStart(3)} ${r.chat} full ${String(r.fullChars).padStart(6)} ` +
      `recall base ${r.baseHit}/${r.gt}  jev ${r.jevHit}/${r.gt}  (${r.jevChars}c, ${r.calls} calls, ${r.jevMs}ms)  ${cs.cmd.slice(0, 50).replace(/\n/g, " ")}`,
    );
    if (VERBOSE) console.log("   gt:", cs.gt.slice(0, 6).join(" | "));
  }

  const n = results.length;
  const baseRecall = mean(results.map((r) => r.baseHit / r.gt));
  const jevRecall = mean(results.map((r) => r.jevHit / r.gt));
  console.log("\n=== SUMMARY ===");
  console.log(`cases:                    ${n}`);
  console.log(`token recall  base/jev:   ${(baseRecall * 100).toFixed(0)}% / ${(jevRecall * 100).toFixed(0)}%`);
  console.log(`fetch avoidable (all gt): base ${results.filter((r) => r.baseAll).length}/${n}  jev ${results.filter((r) => r.jevAll).length}/${n}`);
  console.log(`jev better / same / worse: ${results.filter((r) => r.jevHit > r.baseHit).length} / ${results.filter((r) => r.jevHit === r.baseHit).length} / ${results.filter((r) => r.jevHit < r.baseHit).length}`);
  console.log(`jev latency ms:           mean ${Math.round(mean(results.map((r) => r.jevMs)))} p50 ${pct(results.map((r) => r.jevMs), 50)} p95 ${pct(results.map((r) => r.jevMs), 95)}`);
  console.log(`jev calls / result:       ${mean(results.map((r) => r.calls)).toFixed(1)}  (chunks ${mean(results.map((r) => r.chunks)).toFixed(0)}, full ${Math.round(mean(results.map((r) => r.fullChars)))} chars)`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ config: { N, BUDGET, CHUNK, MIN_LEVEL }, results }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
