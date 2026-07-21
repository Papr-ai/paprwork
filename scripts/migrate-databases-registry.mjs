#!/usr/bin/env node
/**
 * Backfill ~/Papr/data/databases.json from existing app data-sources.json entries.
 * Safe to run repeatedly — dedupes by normalized dbPath (same as gateway init).
 */

import { initializeDatabaseRegistry } from "../src/gateway/services/DatabaseRegistryService.js";

async function main(): Promise<void> {
  const registry = await initializeDatabaseRegistry();
  const added = await registry.backfillFromAppsIfNeeded();
  const active = registry.listActive();
  console.log(
    `[migrate-databases-registry] Backfill complete. added=${added} totalActive=${active.length}`,
  );
  for (const record of active) {
    console.log(
      `  - ${record.dbId} ${record.label ?? ""} → ${record.localPath} (${record.tursoShortName})`,
    );
  }
}

main().catch((error) => {
  console.error("[migrate-databases-registry] Failed:", error);
  process.exit(1);
});
