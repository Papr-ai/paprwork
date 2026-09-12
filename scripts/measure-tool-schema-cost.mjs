#!/usr/bin/env node
/**
 * Measure what the tool block actually costs on the wire, per tool.
 *
 * `AgentService` estimates it as `JSON.stringify(tools).length / 4`, which is a
 * poor proxy twice over: a Zod schema stringifies to almost nothing (the shape
 * lives in `_def`), and `chars/4` is ~1.4x optimistic on schema text. This
 * builds the payload the provider really receives — `{name, description,
 * input_schema}` per tool — and counts it with the real tokenizer.
 *
 * Usage:
 *   node scripts/measure-tool-schema-cost.mjs            # ranked table
 *   node scripts/measure-tool-schema-cost.mjs --json      # machine readable
 *   node scripts/measure-tool-schema-cost.mjs --top 30
 */

import { z } from "zod";
import { getEncoding } from "js-tiktoken";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const topN = (() => {
  const i = args.indexOf("--top");
  return i === -1 ? 20 : Number(args[i + 1]) || 20;
})();

const enc = getEncoding("cl100k_base");
const countTokens = (s) => enc.encode(s).length;

const { allTools } = await import("../dist/core/tools/index.js");
const tools = Array.isArray(allTools) ? allTools : Object.values(allTools);

/** The wire shape: what Anthropic/OpenAI receive for one tool. */
function wirePayload(tool) {
  const name = tool.id ?? tool.name ?? "unknown";
  const description = tool.description ?? "";

  let inputSchema = {};
  try {
    const schema = tool.inputSchema;
    if (schema && typeof schema === "object") {
      // Zod 4 exposes toJSONSchema; anything already plain passes through.
      inputSchema =
        "_def" in schema || "_zod" in schema
          ? z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })
          : schema;
    }
  } catch (err) {
    inputSchema = { __conversionFailed: String(err?.message ?? err) };
  }

  return { name, description, input_schema: inputSchema };
}

const rows = tools.map((tool) => {
  const payload = wirePayload(tool);
  const schemaJson = JSON.stringify(payload.input_schema);
  const wholeJson = JSON.stringify(payload);
  return {
    name: payload.name,
    descTokens: countTokens(payload.description),
    schemaTokens: countTokens(schemaJson),
    totalTokens: countTokens(wholeJson),
    chars: wholeJson.length,
    conversionFailed: schemaJson.includes("__conversionFailed"),
  };
});

rows.sort((a, b) => b.totalTokens - a.totalTokens);

const total = rows.reduce((n, r) => n + r.totalTokens, 0);
const totalChars = rows.reduce((n, r) => n + r.chars, 0);
const failed = rows.filter((r) => r.conversionFailed);

if (asJson) {
  console.log(JSON.stringify({ total, totalChars, count: rows.length, rows }, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log(`\nTool block: ${rows.length} tools, ${total.toLocaleString()} tokens (${totalChars.toLocaleString()} chars)`);
console.log(`Real chars/token ratio: ${(totalChars / total).toFixed(2)}  (AgentService assumes 4.00)`);
console.log(`AgentService's own estimate would read: ${Math.ceil(totalChars / 4).toLocaleString()}\n`);

if (failed.length) {
  console.log(`WARNING: ${failed.length} schema conversions failed — figures below understate those tools:`);
  for (const r of failed) console.log(`  - ${r.name}`);
  console.log("");
}

console.log(`${pad("tool", 34)}${num("tokens", 8)}${num("desc", 7)}${num("schema", 8)}${num("share", 8)}${num("cumul", 8)}`);
console.log("-".repeat(73));
let cumul = 0;
for (const r of rows.slice(0, topN)) {
  cumul += r.totalTokens;
  console.log(
    pad(r.name, 34) +
      num(r.totalTokens.toLocaleString(), 8) +
      num(r.descTokens, 7) +
      num(r.schemaTokens.toLocaleString(), 8) +
      num(((100 * r.totalTokens) / total).toFixed(1) + "%", 8) +
      num(((100 * cumul) / total).toFixed(1) + "%", 8),
  );
}

// Concentration: how few tools carry how much of the cost.
for (const k of [5, 10, 20, 40]) {
  const share = rows.slice(0, k).reduce((n, r) => n + r.totalTokens, 0);
  console.log(
    `\ntop ${k} tools = ${share.toLocaleString()} tokens (${((100 * share) / total).toFixed(1)}% of block)`,
  );
}
console.log("");
