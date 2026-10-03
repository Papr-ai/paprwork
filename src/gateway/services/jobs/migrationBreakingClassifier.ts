/**
 * Classify a migration as additive (safe to sync to cloud immediately) or breaking
 * (must be held locally and published together with the code that expects it).
 *
 * Breaking = anything the currently-live code could depend on disappearing or changing
 * shape: DROP TABLE, DROP COLUMN, RENAME COLUMN, RENAME TABLE (including the SQLite
 * "rebuild" idiom: CREATE x_new → copy → DROP x → RENAME x_new TO x), DROP VIEW/TRIGGER.
 *
 * Not breaking: CREATE TABLE/INDEX/VIEW/TRIGGER, ADD COLUMN, DROP INDEX, data DML,
 * DROP of a table created earlier in the same migration (scratch/temp tables).
 */

import { parseDropColumnStatement, parseRenameColumnStatement } from "./migrationStatementGuard.js";
import {
  parseCreateTableStatement,
  parseDropStatement,
  parseRenameTableStatement,
  splitSqlStatements,
  stripLeadingLineComments,
} from "./migrationSqlHelpers.js";

export type BreakingKind =
  | "drop_table"
  | "drop_column"
  | "rename_column"
  | "rename_table"
  | "table_rebuild"
  | "drop_view_or_trigger";

export interface BreakingChange {
  kind: BreakingKind;
  table: string;
  detail?: string;
  statement: string;
}

export interface MigrationClassification {
  breaking: boolean;
  changes: BreakingChange[];
}

const DROP_VIEW_OR_TRIGGER = /^DROP\s+(VIEW|TRIGGER)\s+(?:IF\s+EXISTS\s+)?["`[]?([\w$]+)/i;
const norm = (name: string) => name.replace(/^["`[]|["`\]]$/g, "").toLowerCase();

export function classifyMigrationSql(sql: string): MigrationClassification {
  const statements = splitSqlStatements(sql)
    .map((s) => stripLeadingLineComments(s).trim())
    .filter(Boolean);

  const createdHere = new Set<string>();
  const changes: BreakingChange[] = [];
  const droppedPreexisting = new Map<string, string>(); // table → DROP statement

  for (const statement of statements) {
    const created = parseCreateTableStatement(statement);
    if (created) {
      createdHere.add(norm(created.table));
      continue;
    }

    const drop = parseDropStatement(statement);
    if (drop) {
      if (drop.objectType === "index") continue;
      const table = norm(drop.name);
      if (createdHere.has(table)) {
        createdHere.delete(table);
        continue; // scratch table from this same migration
      }
      droppedPreexisting.set(table, statement);
      changes.push({ kind: "drop_table", table, statement });
      continue;
    }

    const viewOrTrigger = DROP_VIEW_OR_TRIGGER.exec(statement);
    if (viewOrTrigger) {
      // Platform-managed sync triggers (_papr_*) are recreated by the runtime, not app code.
      if (viewOrTrigger[1].toLowerCase() === "trigger" && norm(viewOrTrigger[2]).startsWith("_papr_")) continue;
      changes.push({ kind: "drop_view_or_trigger", table: norm(viewOrTrigger[2]), detail: viewOrTrigger[1].toLowerCase(), statement });
      continue;
    }

    const renameTable = parseRenameTableStatement(statement);
    if (renameTable) {
      const from = norm(renameTable.from);
      const to = norm(renameTable.to);
      if (createdHere.has(from) && droppedPreexisting.has(to)) {
        // SQLite rebuild idiom: x_new created here, original x dropped, x_new renamed to x.
        const idx = changes.findIndex((c) => c.kind === "drop_table" && c.table === to);
        if (idx >= 0) changes.splice(idx, 1);
        changes.push({ kind: "table_rebuild", table: to, detail: `via ${from}`, statement });
        createdHere.delete(from);
        continue;
      }
      if (createdHere.has(from)) {
        createdHere.delete(from);
        createdHere.add(to);
        continue; // renaming a table that only exists inside this migration
      }
      changes.push({ kind: "rename_table", table: from, detail: `→ ${to}`, statement });
      continue;
    }

    const dropColumn = parseDropColumnStatement(statement);
    if (dropColumn && !/\bDROP\s+CONSTRAINT\b/i.test(statement)) {
      if (!createdHere.has(norm(dropColumn.table))) {
        changes.push({ kind: "drop_column", table: norm(dropColumn.table), detail: dropColumn.column, statement });
      }
      continue;
    }

    const renameColumn = parseRenameColumnStatement(statement);
    if (renameColumn) {
      if (!createdHere.has(norm(renameColumn.table))) {
        changes.push({
          kind: "rename_column",
          table: norm(renameColumn.table),
          detail: `${renameColumn.from} → ${renameColumn.to}`,
          statement,
        });
      }
    }
  }

  return { breaking: changes.length > 0, changes };
}
