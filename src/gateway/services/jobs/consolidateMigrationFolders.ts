/**
 * One migrations folder per database.
 *
 * The real folder is $PAPR_HOME/data/databases/{slug}/migrations. Older installs
 * also left copies under apps/{id}/data/databases/{slug}/migrations (and
 * apps/{id}/databases/...), which drift from the real one. This plans a
 * one-time cleanup using only facts, never guesses:
 *
 *   - identical file already in the real folder  -> remove the copy
 *   - applied, not in the real folder            -> move into the real folder
 *     (it will not run again; it is already applied)
 *   - everything else (unapplied, differs from the real file, .backup / .disabled)
 *     -> quarantine; never deleted, never run
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { hashSql } from "./restoredMigrations.js";

export const QUARANTINE_DIR = "_quarantine";

export type ShadowAction =
  | { kind: "remove_duplicate"; file: string }
  | { kind: "move_to_real"; file: string }
  | { kind: "quarantine"; file: string; reason: string };

export interface ShadowFile {
  /** File name only, e.g. 0026_interviews.sql or 0011_x.sql.backup.123 */
  name: string;
  content: string;
}

const isMigrationSql = (n: string) => /^\d{4}_.+\.sql$/.test(n);

export function planShadowCleanup(input: {
  shadow: ShadowFile[];
  real: Map<string, string>;
  appliedIds: ReadonlySet<string>;
}): ShadowAction[] {
  const out: ShadowAction[] = [];
  for (const f of input.shadow) {
    if (!isMigrationSql(f.name)) {
      out.push({ kind: "quarantine", file: f.name, reason: "backup/disabled copy" });
      continue;
    }
    const id = f.name.replace(/\.sql$/, "");
    const real = input.real.get(f.name);
    if (real !== undefined) {
      if (hashSql(real) === hashSql(f.content)) out.push({ kind: "remove_duplicate", file: f.name });
      else out.push({ kind: "quarantine", file: f.name, reason: "differs from the real file" });
      continue;
    }
    if (input.appliedIds.has(id)) out.push({ kind: "move_to_real", file: f.name });
    else out.push({ kind: "quarantine", file: f.name, reason: "not applied" });
  }
  return out;
}

async function readDirFiles(dir: string): Promise<ShadowFile[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ShadowFile[] = [];
  for (const name of names.sort()) {
    const full = path.join(dir, name);
    const stat = await fs.stat(full);
    if (stat.isFile()) out.push({ name, content: await fs.readFile(full, "utf8") });
  }
  return out;
}

export interface ConsolidateResult {
  dir: string;
  actions: ShadowAction[];
}

/** Execute the plan for one shadow directory. dryRun reports without touching disk. */
export async function consolidateShadowDir(input: {
  shadowDir: string;
  realDir: string;
  appliedIds: ReadonlySet<string>;
  dryRun?: boolean;
}): Promise<ConsolidateResult> {
  const shadow = await readDirFiles(input.shadowDir);
  const realFiles = await readDirFiles(input.realDir);
  const real = new Map(realFiles.map((f) => [f.name, f.content]));
  const actions = planShadowCleanup({ shadow, real, appliedIds: input.appliedIds });
  if (input.dryRun) return { dir: input.shadowDir, actions };

  for (const a of actions) {
    const from = path.join(input.shadowDir, a.file);
    if (a.kind === "remove_duplicate") {
      await fs.rm(from, { force: true });
    } else if (a.kind === "move_to_real") {
      await fs.mkdir(input.realDir, { recursive: true });
      await fs.copyFile(from, path.join(input.realDir, a.file), 1 /* COPYFILE_EXCL */);
      await fs.rm(from, { force: true });
    } else {
      const q = path.join(input.shadowDir, QUARANTINE_DIR);
      await fs.mkdir(q, { recursive: true });
      await fs.rename(from, path.join(q, a.file));
    }
  }
  return { dir: input.shadowDir, actions };
}
