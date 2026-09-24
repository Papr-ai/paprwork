/**
 * Block agents from hand-writing registry DB migration files.
 *
 * New migrations must come from papr_db_create_migration, which assigns
 * NNNN_YYYYMMDDHHMMSS_name.sql so collaborators can never produce the same
 * filename. Existing migrations are immutable once applied (the ledger keys on
 * filename, so editing one silently never re-runs on other machines).
 *
 * System code (Get updates pull, hydrate, apply) writes these paths directly
 * via fs — this guard only sits in front of agent file tools and bash.
 */

import path from "path";
import { getPaprRoot } from "./paprRoot.js";

const MIGRATION_SEGMENT = /[/\\]databases[/\\]([^/\\]+)[/\\]migrations[/\\][^/\\]+$/;

/** Registry migrations: $PAPR_HOME/data/databases/{slug}/migrations/* and apps/{id}/databases/{slug}/migrations/* */
export function registryMigrationSlugForPath(resolvedPath: string): string | null {
  const resolved = path.resolve(resolvedPath);
  const root = path.resolve(getPaprRoot());
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  const rel = path.relative(root, resolved).split(path.sep).join("/");
  if (!/^(data\/databases|apps\/[^/]+\/databases)\/[^/]+\/migrations\/[^/]+$/.test(rel)) {
    return null;
  }
  return MIGRATION_SEGMENT.exec(resolved)?.[1] ?? null;
}

export function migrationFileBlockReason(resolvedPath: string): string | null {
  const slug = registryMigrationSlugForPath(resolvedPath);
  if (!slug) {
    return null;
  }
  return (
    `⛔ Do not write or edit migration files directly (${path.basename(resolvedPath)}). ` +
    `New schema change → papr_db_create_migration({ dbId, name: "add_notes", sql: "ALTER TABLE …" }) — ` +
    `the system assigns the filename (number + timestamp) and applies it. ` +
    `Existing migrations are immutable once applied: to change schema again, create a new migration. ` +
    `Database slug: ${slug} (look up dbId in databases.json / read_app_data_sources).`
  );
}

/** Bash writes into a registry migrations folder (redirects, tee, cp, mv, touch, sed -i). */
export function bashMigrationWriteBlockReason(command: string): string | null {
  if (!/databases\/[^\s/'"]+\/migrations\//.test(command)) {
    return null;
  }
  const writes =
    /(>>?|\btee\b|\bcp\b|\bmv\b|\btouch\b|\bsed\s+-i|\bperl\s+-pi|\binstall\b|\brsync\b|\bln\b)[^|;&]*databases\/[^\s/'"]+\/migrations\//;
  if (!writes.test(command)) {
    return null;
  }
  return (
    "⛔ Do not create or modify migration files via bash. " +
    'Use papr_db_create_migration({ dbId, name, sql }) — it names the file (number + timestamp) and applies it.'
  );
}
