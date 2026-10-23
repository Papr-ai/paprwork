#!/usr/bin/env node
/**
 * Run the unit tests for one product area.
 *
 *   npm run test:area                     # list areas with file counts
 *   npm run test:area cloud-sync          # all of tests/cloud-sync/**
 *   npm run test:area cloud-sync/collaboration
 *   npm run test:area jobs -- -t "lease"  # extra args go to vitest
 *
 * Areas are the folders under tests/ (see tests/README.md). Build-tier
 * (*.build.test.ts) and live (*.live.test.ts) files are skipped here, the same
 * as in `npm test`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = path.join(ROOT, "tests");
const NOT_AREAS = new Set(["setup", "helpers", "fixtures", "manual", "unit"]);

function countTests(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countTests(p);
    else if (/\.test\.tsx?$/.test(e.name) && !/\.(build|live)\.test\./.test(e.name)) n++;
  }
  return n;
}

function listAreas(dir = TESTS, prefix = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || (!prefix && NOT_AREAS.has(e.name))) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    out.push({ area: rel, files: countTests(full) });
    out.push(...listAreas(full, rel));
  }
  return out;
}

const [area, ...rest] = process.argv.slice(2);
const areas = listAreas();

if (!area) {
  console.log("Usage: npm run test:area <area> [-- vitest args]\n");
  for (const a of areas) console.log(`  ${a.area.padEnd(28)} ${String(a.files).padStart(4)} files`);
  process.exit(0);
}

if (!areas.some((a) => a.area === area)) {
  console.error(`Unknown area "${area}". Run \`npm run test:area\` to list areas.`);
  process.exit(2);
}

const r = spawnSync(
  "npx",
  ["vitest", "run", "--project", "unit-backend", `tests/${area}/`, ...rest],
  { cwd: ROOT, stdio: "inherit" },
);
process.exit(r.status ?? 1);
