#!/usr/bin/env node
/**
 * List databases.json entries whose localPath is job scratch (Jobs/{id}/data/data.db).
 *
 * Usage:
 *   npm run check:registry-job-scratch
 *   npm run check:registry-job-scratch -- --papr-home=$HOME/Papr/orgs/.../namespaces/...
 *   npm run check:registry-job-scratch -- --json
 *
 * Exit code: 0 when clean, 1 when any finding (for CI).
 */

import { scanRegistryJobScratchPaths } from "../src/gateway/services/registryJobScratchPathAudit.js";

function readFlagValue(flag) {
  const prefix = `${flag}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg === flag) {
      const index = process.argv.indexOf(arg);
      return process.argv[index + 1];
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

const jsonOut = process.argv.includes("--json");
const scopePaprHome = readFlagValue("--papr-home");

async function main() {
  const result = await scanRegistryJobScratchPaths({
    ...(scopePaprHome ? { scopePaprHome } : {}),
  });

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[check:registry-job-scratch] Scanned ${result.scannedRegistries} databases.json file(s).`,
    );
    if (result.findings.length === 0) {
      console.log(
        "[check:registry-job-scratch] OK — no registry localPath under Jobs/*/data/data.db.",
      );
    } else {
      console.log(
        `[check:registry-job-scratch] Found ${result.findings.length} mis-pointed record(s):\n`,
      );
      for (const row of result.findings) {
        console.log(`  workspace: ${row.workspaceRoot}`);
        console.log(`  registry:  ${row.registryPath}`);
        console.log(`  dbId:      ${row.dbId} (${row.status}, syncMode=${row.syncMode ?? "default"})`);
        console.log(`  localPath: ${row.localPath}`);
        if (row.ownerJobId) {
          console.log(`  ownerJobId: ${row.ownerJobId}`);
        }
        console.log(`  turso:     ${row.tursoShortName}`);
        console.log("");
      }
      console.log(
        "Fix: promote app data to data/databases/{slug}/data.db (promote_job_database / create_database), " +
          "update data-sources.json dbId/dbPath, then tombstone or remove the scratch registry row.",
      );
      console.log(
        "Runtime: job scratch is treated as local-only even if still listed here (see jobScratchDatabasePath).",
      );
    }
  }

  process.exit(result.findings.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("[check:registry-job-scratch] Failed:", error);
  process.exit(2);
});
