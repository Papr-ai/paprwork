#!/usr/bin/env node
/**
 * Prune Turso databases — clean slate or remove legacy/test artifacts.
 *
 * Current model: one DB per linked job (`j-{jobId8}`), e.g. p-*-j-de1a89d8.
 * Legacy model (removed): shared user DB `*-data` with prefixed tables.
 *
 * Usage:
 *   node scripts/prune-turso-databases.mjs              # dry-run (default)
 *   node scripts/prune-turso-databases.mjs --execute      # delete matched DBs
 *   node scripts/prune-turso-databases.mjs --all --execute  # delete every DB in org
 *   node scripts/prune-turso-databases.mjs --legacy-data --execute  # delete *-data only
 *
 * Env (or ../memory/.env):
 *   TURSO_ORG_SLUG
 *   TURSO_PLATFORM_TOKEN
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TURSO_API_BASE = "https://api.turso.tech/v1";

const USER_DATA_SUFFIX = "-data";
const JOB_REPLICA_SHORT = /^j-[a-f0-9]{8}$/;

/** Short-name patterns from old per-job provisioning and test scripts. */
const LEGACY_JOB_SHORT = /^job-/;

const TEST_SHORT_PATTERNS = [
  /^chats$/,
  /^test-chats$/,
  /^sync-test$/,
  /^health-check$/,
  /^coexist-/,
  /^checkpoint-/,
  /^init-test-/,
  /^libsql-write-/,
  /^mixed-write-/,
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  return {
    execute: argv.includes("--execute"),
    deleteAll: argv.includes("--all"),
    legacyData: argv.includes("--legacy-data"),
    jobsOnly: argv.includes("--jobs-only"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function shortNameFromFull(fullName) {
  // p-{org8}-{ns8}-{user8}-{db...}
  const match = fullName.match(/^p-[^-]+-[^-]+-[^-]+-(.+)$/);
  return match?.[1] ?? fullName;
}

function isUserDataDb(fullName) {
  return fullName.endsWith(USER_DATA_SUFFIX);
}

function isLegacyJobDb(shortName) {
  return LEGACY_JOB_SHORT.test(shortName);
}

function isTestDb(shortName) {
  return TEST_SHORT_PATTERNS.some((pattern) => pattern.test(shortName));
}

function classifyDatabase(fullName, options) {
  if (options.deleteAll) {
    return "delete";
  }

  const shortName = shortNameFromFull(fullName);

  if (options.legacyData) {
    return isUserDataDb(fullName) ? "delete" : "skip";
  }

  if (options.jobsOnly) {
    return JOB_REPLICA_SHORT.test(shortName) || isLegacyJobDb(shortName)
      ? "delete"
      : "skip";
  }

  // Default: legacy shared *-data + old job-* + test DBs
  if (isUserDataDb(fullName) || isLegacyJobDb(shortName) || isTestDb(shortName)) {
    return "delete";
  }

  if (JOB_REPLICA_SHORT.test(shortName)) {
    return "keep";
  }

  return "skip";
}

async function listOrgDatabases(org, token) {
  const response = await fetch(
    `${TURSO_API_BASE}/organizations/${org}/databases`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`List databases failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  return (data.databases ?? []).map((db) => db.Name ?? db.name ?? "").filter(Boolean);
}

async function deleteDatabase(org, token, fullName) {
  const response = await fetch(
    `${TURSO_API_BASE}/organizations/${org}/databases/${encodeURIComponent(fullName)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
  if (response.status === 404) {
    return { fullName, ok: true, status: 404 };
  }
  if (response.status === 200 || response.status === 204) {
    return { fullName, ok: true, status: response.status };
  }
  const body = await response.text();
  return {
    fullName,
    ok: false,
    status: response.status,
    error: body.slice(0, 200),
  };
}

function printHelp() {
  console.log(`
Prune Turso databases (legacy shared *-data, test artifacts, or full wipe).

Options:
  --execute       Actually delete (default is dry-run)
  --all           Delete every database in the org
  --legacy-data   Delete only shared *-data databases (old model)
  --jobs-only     Delete j-* job replicas and legacy job-* names
  --help          Show this help

Examples:
  node scripts/prune-turso-databases.mjs --all --execute
  node scripts/prune-turso-databases.mjs --legacy-data --execute
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  loadEnvFile(path.join(__dirname, "../../memory/.env"));
  loadEnvFile(path.join(process.cwd(), "../memory/.env"));

  const org = process.env.TURSO_ORG_SLUG;
  const token = process.env.TURSO_PLATFORM_TOKEN;
  if (!org || !token) {
    console.error(
      "Missing TURSO_ORG_SLUG or TURSO_PLATFORM_TOKEN. Set env vars or add to ../memory/.env",
    );
    process.exit(1);
  }

  const mode = options.deleteAll
    ? "delete ALL databases"
    : options.legacyData
      ? "legacy *-data only"
      : options.jobsOnly
        ? "job replicas (j-* and job-*)"
        : "default (legacy *-data, job-*, test DBs; keep j-*)";
  console.log(`\nTurso prune — org: ${org}`);
  console.log(`Mode: ${mode}`);
  console.log(options.execute ? "Action: DELETE\n" : "Action: DRY-RUN (pass --execute to delete)\n");

  const allNames = await listOrgDatabases(org, token);
  const keep = [];
  const toDelete = [];
  const skip = [];

  for (const fullName of allNames.sort()) {
    const bucket = classifyDatabase(fullName, options);
    if (bucket === "keep") {
      keep.push(fullName);
    } else if (bucket === "delete") {
      toDelete.push(fullName);
    } else {
      skip.push(fullName);
    }
  }

  console.log(`Total: ${allNames.length}  Keep: ${keep.length}  Delete: ${toDelete.length}  Skip: ${skip.length}\n`);

  if (keep.length > 0) {
    console.log("Keep:");
    for (const name of keep) {
      console.log(`  ✓ ${name}`);
    }
    console.log();
  }

  if (skip.length > 0 && !options.deleteAll) {
    console.log("Skip:");
    for (const name of skip.slice(0, 20)) {
      console.log(`  - ${name}`);
    }
    if (skip.length > 20) {
      console.log(`  ... and ${skip.length - 20} more`);
    }
    console.log();
  }

  if (toDelete.length === 0) {
    console.log("Nothing to delete.\n");
    return;
  }

  console.log(`Will delete ${toDelete.length} database(s):`);
  for (const name of toDelete.slice(0, 30)) {
    console.log(`  ✗ ${name}`);
  }
  if (toDelete.length > 30) {
    console.log(`  ... and ${toDelete.length - 30} more`);
  }
  console.log();

  if (!options.execute) {
    console.log("Dry-run complete. Re-run with --execute to delete.\n");
    return;
  }

  let deleted = 0;
  let failed = 0;
  for (const fullName of toDelete) {
    const result = await deleteDatabase(org, token, fullName);
    if (result.ok) {
      deleted += 1;
      process.stdout.write(".");
    } else {
      failed += 1;
      console.error(`\nFailed ${fullName} (${result.status}): ${result.error ?? ""}`);
    }
  }

  console.log(`\n\nDone: deleted=${deleted} failed=${failed} remaining≈${allNames.length - deleted}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
