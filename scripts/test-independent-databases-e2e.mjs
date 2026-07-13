#!/usr/bin/env node
/**
 * Lightweight E2E checks for independent databases (no gateway required).
 *
 * Usage: node --import tsx scripts/test-independent-databases-e2e.mjs
 */

import {
  dbTursoDatabaseName,
  jobTursoDatabaseName,
  resolveTursoShortName,
} from "../src/gateway/services/tursoDatabaseNaming.ts";
import {
  dbIdFromPath,
  normalizeDbPath,
} from "../src/gateway/services/DatabaseRegistryService.ts";

let passed = 0;
let failed = 0;

function ok(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

console.log("Independent databases E2E (local checks)\n");

// 1. Naming contract
ok("job Turso name", jobTursoDatabaseName("de1a89d8-0000-0000-0000-000000000001") === "j-de1a89d8");
ok("standalone Turso name", dbTursoDatabaseName("db-abcdef12") === "d-abcdef12");
const perUser = resolveTursoShortName(
  { dbId: "db-abcdef12", isolation: "per-user" },
  "user-12345678-aaaa-bbbb-cccc-ddddeeeeffff",
);
ok("per-user suffix", perUser === "d-abcdef12-u-user1234");

// 2. Registry dbId stability
const p1 = "/tmp/foo/data.db";
const p2 = normalizeDbPath("/tmp//foo/data.db");
ok("dbId stable across path normalize", dbIdFromPath(p1) === dbIdFromPath(p2));

// 3. data-sources contract (manual checklist reminder)
console.log("\nManual E2E (run with gateway + Papr login):");
console.log("  - create_database → attach_database → /api/db/query returns rows");
console.log("  - create_job({ appIds }) → data-sources.json has primary without manual link");
console.log("  - team write on cloud app → desktop pull does not overwrite");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
