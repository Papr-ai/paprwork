#!/usr/bin/env node
/**
 * Which tools are actually called, and what their schemas cost to send.
 *
 * `MEASURED_CORE_TOOL_IDS` in `toolDeferral.ts` is derived from this, not from
 * taste — deferral only pays if the tools kept are the tools used, and that is
 * a property of real traffic rather than of anyone's mental model. Run it
 * against your own history before editing that list by hand.
 *
 * Costs are reported with the repo's own estimator (`estimateToolTokens`,
 * chars/4) rather than a real tokenizer, so the output is directly comparable
 * to the figure `computeHistoryTokenBudget` subtracts. For the tokenized truth
 * use `measure-tool-schema-cost.mjs`, which runs ~4.4% lower.
 *
 * Usage:
 *   npm run measure:tool-usage
 *   npm run measure:tool-usage -- --top 40      # rows to print
 *   npm run measure:tool-usage -- --emit        # paste-ready core list
 */

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

import { allTools } from "../src/core/tools/index.js";
import { estimateToolTokens } from "../src/gateway/services/agent/toolSchemaTokens.js";

const args = process.argv.slice(2);
const emit = args.includes("--emit");
const topN = (() => {
  const i = args.indexOf("--top");
  return i === -1 ? 40 : Number(args[i + 1]) || 40;
})();

const dbPath =
  args.find((a) => a.startsWith("--db="))?.slice(5) ??
  path.join(homedir(), ".paprwork-v2", "chats.db");

if (!existsSync(dbPath)) {
  console.error(`No chat database at ${dbPath}. Pass --db=<path>.`);
  process.exit(1);
}

const registry = Object.create(null);
for (const tool of allTools) registry[tool.id] = tool;

const db = new DatabaseSync(dbPath, { readOnly: true });
const recorded = db
  .prepare(
    `SELECT json_extract(j.value,'$.name') AS name, COUNT(*) AS n
       FROM messages m, json_each(m.tool_calls) j
      WHERE m.tool_calls IS NOT NULL
        AND m.tool_calls != ''
        AND m.tool_calls != '[]'
      GROUP BY name
      ORDER BY n DESC`,
  )
  .all()
  .filter((r) => r.name)
  .map((r) => ({ name: r.name, n: Number(r.n) }));
db.close();

// A name that is no longer registered is neither sent nor deferrable, so
// counting its calls would understate how much of live traffic a core list
// covers. Reported separately rather than silently dropped.
const live = recorded.filter((r) => registry[r.name]);
const retired = recorded.filter((r) => !registry[r.name]);
const totalCalls = live.reduce((s, r) => s + r.n, 0);
const retiredCalls = retired.reduce((s, r) => s + r.n, 0);

if (totalCalls === 0) {
  console.error(
    `No tool calls found in ${dbPath}. Nothing to rank — use the defaults.`,
  );
  process.exit(1);
}

const fullBlock = Object.entries(registry).reduce(
  (s, [id, tool]) => s + estimateToolTokens(id, tool),
  0,
);

console.log(`database        : ${dbPath}`);
console.log(
  `calls           : ${totalCalls.toLocaleString()} across ${live.length} live tools` +
    (retiredCalls
      ? ` (+${retiredCalls.toLocaleString()} to ${retired.length} retired names, excluded)`
      : ""),
);
console.log(
  `registry        : ${Object.keys(registry).length} tools, ${fullBlock.toLocaleString()} tokens if all sent`,
);
console.log("");

console.log("rank  calls    cum%    tokens  tool");
let cum = 0;
live.slice(0, topN).forEach((r, i) => {
  cum += r.n;
  const tok = estimateToolTokens(r.name, registry[r.name]);
  console.log(
    `${String(i + 1).padStart(4)}  ${String(r.n).padStart(6)}  ${((cum / totalCalls) * 100).toFixed(1).padStart(5)}%  ${String(tok).padStart(6)}  ${r.name}`,
  );
});

console.log("\ncoverage curve (pick the knee, not the maximum):");
for (const k of [20, 30, 40, 50, 60]) {
  const top = live.slice(0, k);
  const covered = top.reduce((s, r) => s + r.n, 0);
  const cost = top.reduce(
    (s, r) => s + estimateToolTokens(r.name, registry[r.name]),
    0,
  );
  console.log(
    `  top${String(k).padEnd(3)} coverage ${((covered / totalCalls) * 100).toFixed(1).padStart(5)}%   cost ${String(cost).padStart(6)}   deferred ${String(fullBlock - cost).padStart(6)}`,
  );
}

// Frequency is not cost, and conflating them is the mistake this guards
// against: a rarely-called tool with an expensive schema is exactly what
// deferral exists to withhold.
const priciest = Object.entries(registry)
  .map(([id, tool]) => ({
    id,
    tok: estimateToolTokens(id, tool),
    n: live.find((r) => r.name === id)?.n ?? 0,
  }))
  .sort((a, b) => b.tok - a.tok)
  .slice(0, 8);
console.log("\nmost expensive schemas, with their call counts:");
for (const p of priciest) {
  console.log(
    `  ${String(p.tok).padStart(5)} tokens  ${String(p.n).padStart(6)} calls  ${p.id}`,
  );
}

if (emit) {
  console.log("\nexport const MEASURED_CORE_TOOL_IDS: readonly string[] = [");
  for (const r of live.slice(0, topN)) console.log(`  "${r.name}",`);
  console.log("];");
}
