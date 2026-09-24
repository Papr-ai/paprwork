/**
 * System-assigned migration filenames: NNNN_YYYYMMDDHHMMSS_name.sql
 *
 * The number keeps ordering identical to legacy 0001_init-style files (all
 * consumers sort ids as plain strings). The UTC timestamp makes filenames
 * unique across collaborators who pick the same next number, so a pulled
 * migration can never be mistaken for one already applied under the same name.
 * Agents pass only a short name + SQL — never the number or timestamp.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

const LEADING_NUMBER = /^(\d{4})_/;

export function slugifyMigrationName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\.sql$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || "migration";
}

export function formatMigrationTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** Next 4-digit number after the highest existing migration file. */
export function nextMigrationNumber(existingFileNames: readonly string[]): number {
  let max = 0;
  for (const name of existingFileNames) {
    const match = LEADING_NUMBER.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export function buildMigrationFileName(input: {
  existingFileNames: readonly string[];
  name: string;
  now?: Date;
}): string {
  const number = String(nextMigrationNumber(input.existingFileNames)).padStart(4, "0");
  const stamp = formatMigrationTimestamp(input.now ?? new Date());
  return `${number}_${stamp}_${slugifyMigrationName(input.name)}.sql`;
}

/** Write a new migration under {migrationRoot}/migrations with a system-assigned name. */
export async function createMigrationFile(input: {
  migrationRoot: string;
  name: string;
  sql: string;
  now?: Date;
}): Promise<{ fileName: string; migrationId: string; fullPath: string }> {
  const dir = path.join(input.migrationRoot, "migrations");
  await fs.mkdir(dir, { recursive: true });
  const existing = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql"));
  const fileName = buildMigrationFileName({
    existingFileNames: existing,
    name: input.name,
    now: input.now,
  });
  const fullPath = path.join(dir, fileName);
  // wx: never overwrite (same-second double call gets a clear error, not a silent clobber)
  await fs.writeFile(fullPath, input.sql.trim() + "\n", { flag: "wx" });
  return { fileName, migrationId: fileName.replace(/\.sql$/, ""), fullPath };
}
