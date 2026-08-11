/**
 * Phase 4 flush step 1 — apply pending local SQLite migrations for all linked sources.
 */

import * as fs from "fs";
import {
  applyDatabaseMigrations,
  resolveMigrationRootFromDbPath,
} from "../jobs/databaseMigrations.js";
import { discoverTursoLinkedSources } from "../tursoLinkedSources.js";

export async function applyLocalMigrationsForApp(
  appId: string,
  appsRootDir: string,
): Promise<string[]> {
  const sources = (await discoverTursoLinkedSources(appsRootDir)).filter(
    (source) => source.appId === appId,
  );

  const applied: string[] = [];
  for (const source of sources) {
    if (!fs.existsSync(source.dbPath)) {
      continue;
    }
    const migrationRoot = resolveMigrationRootFromDbPath(source.dbPath);
    if (!migrationRoot) {
      continue;
    }
    const migrationIds = await applyDatabaseMigrations(
      migrationRoot,
      source.dbPath,
    );
    for (const id of migrationIds) {
      applied.push(`${source.alias}:${id}`);
    }
  }

  return applied;
}
