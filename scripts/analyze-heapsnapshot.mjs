#!/usr/bin/env node
/**
 * Summarize a V8 heap snapshot: what is holding the memory, grouped by
 * constructor, plus the largest individual objects.
 *
 * Usage:
 *   node --max-old-space-size=8192 scripts/analyze-heapsnapshot.mjs <file.heapsnapshot>
 */

import fs from "fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: analyze-heapsnapshot.mjs <file.heapsnapshot>");
  process.exit(1);
}

const MB = 1024 * 1024;
const mb = (n) => (n / MB).toFixed(1).padStart(8);

console.log(`Reading ${file} (${(fs.statSync(file).size / MB).toFixed(0)}MB)...`);
const snap = JSON.parse(fs.readFileSync(file, "utf8"));

const meta = snap.snapshot.meta;
const nodeFields = meta.node_fields;
const nodeTypes = meta.node_types[0];
const stride = nodeFields.length;

const iType = nodeFields.indexOf("type");
const iName = nodeFields.indexOf("name");
const iSelf = nodeFields.indexOf("self_size");

const nodes = snap.nodes;
const strings = snap.strings;
const count = snap.snapshot.node_count;

const byGroup = new Map(); // "type|name" -> { bytes, count }
const byType = new Map();
const largest = [];
let total = 0;

for (let i = 0; i < count; i++) {
  const base = i * stride;
  const type = nodeTypes[nodes[base + iType]];
  const name = strings[nodes[base + iName]] ?? "";
  const self = nodes[base + iSelf];

  total += self;
  byType.set(type, (byType.get(type) ?? 0) + self);

  const key = `${type}|${name}`;
  const entry = byGroup.get(key);
  if (entry) {
    entry.bytes += self;
    entry.count += 1;
  } else {
    byGroup.set(key, { bytes: self, count: 1, type, name });
  }

  if (self > 1 * MB) {
    largest.push({ self, type, name });
  }
}

console.log(`\nTotal self size: ${(total / MB).toFixed(0)}MB across ${count.toLocaleString()} nodes\n`);

console.log("── By node type ─────────────────────────────────────────");
for (const [type, bytes] of [...byType].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`${mb(bytes)}MB  ${((bytes / total) * 100).toFixed(1).padStart(5)}%  ${type}`);
}

console.log("\n── Top 30 by aggregate size (type / constructor) ────────");
const groups = [...byGroup.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 30);
for (const g of groups) {
  const label = g.name.length > 60 ? g.name.slice(0, 57) + "..." : g.name;
  console.log(
    `${mb(g.bytes)}MB  ${((g.bytes / total) * 100).toFixed(1).padStart(5)}%  ` +
      `${String(g.count).padStart(9)} objs  ${g.type}: ${label || "(unnamed)"}`,
  );
}

console.log("\n── Largest individual objects (>1MB) ────────────────────");
largest.sort((a, b) => b.self - a.self);
for (const n of largest.slice(0, 25)) {
  const label = n.name.length > 90 ? n.name.slice(0, 87).replace(/\n/g, "\\n") + "..." : n.name.replace(/\n/g, "\\n");
  console.log(`${mb(n.self)}MB  ${n.type}: ${label || "(unnamed)"}`);
}
if (largest.length === 0) console.log("  (none — memory is spread across many small objects)");
