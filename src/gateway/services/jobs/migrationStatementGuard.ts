/**
 * "Is this statement already done?" — checked against the LIVE schema, statement
 * by statement, inside the migration's own transaction.
 *
 * Why this exists: migrations used to decide "already applied" from a ledger
 * row alone. When the ledger and the schema disagreed (two ledgers, a reseeded
 * replica, a fork whose database was half-initialised) a non-idempotent
 * statement ran against a schema that already had its effect, e.g.
 *
 *   ALTER TABLE replies RENAME COLUMN prospect_id TO member_id
 *   -> "no such column: prospect_id"   (member_id already existed)
 *
 * and, because nothing was wrapped in a transaction, the migration stopped
 * half-way and left the database in a state no later run could repair.
 *
 * The guard only ever SKIPS a statement whose effect is provably present. It
 * never rewrites SQL, and anything it cannot recognise runs unchanged, so an
 * unexpected state still fails loudly (and, being inside a transaction, rolls
 * the whole migration back).
 */

import {
  parseAddColumnStatement,
  parseCreateIndexStatement,
  parseCreateTableStatement,
  parseDropStatement,
  parseRenameTableStatement,
} from "./migrationSqlHelpers.js";

/** Read-only view of the schema, as seen inside the migration transaction. */
export interface SchemaInspector {
  objectExists(type: "table" | "index" | "view" | "trigger", name: string): Promise<boolean>;
  columnExists(table: string, column: string): Promise<boolean>;
}

export type GuardDecision =
  | { action: "run" }
  | { action: "skip"; reason: string };

export interface GuardOptions {
  /**
   * Turso-primary replay historically skipped ADD COLUMN when the table did not
   * exist (job-scratch tables that only ever existed locally). Kept opt-in so
   * the replica and local runners still fail loudly on a missing table.
   */
  skipAddColumnOnMissingTable?: boolean;
}

const IDENT = String.raw`(?:"([^"]+)"|'([^']+)'|\[([^\]]+)\]|\`([^\`]+)\`|([A-Za-z_][A-Za-z0-9_$]*))`;

function pick(match: RegExpExecArray, start: number): string | null {
  for (let i = start; i < start + 5; i += 1) {
    if (match[i]) {
      return match[i];
    }
  }
  return null;
}

export function parseRenameColumnStatement(
  statement: string,
): { table: string; from: string; to: string } | null {
  const match = new RegExp(
    String.raw`^ALTER\s+TABLE\s+${IDENT}\s+RENAME\s+(?:COLUMN\s+)?${IDENT}\s+TO\s+${IDENT}`,
    "i",
  ).exec(statement.trim());
  if (!match) {
    return null;
  }
  const table = pick(match, 1);
  const from = pick(match, 6);
  const to = pick(match, 11);
  return table && from && to ? { table, from, to } : null;
}

export function parseDropColumnStatement(
  statement: string,
): { table: string; column: string } | null {
  const match = new RegExp(
    String.raw`^ALTER\s+TABLE\s+${IDENT}\s+DROP\s+(?:COLUMN\s+)?${IDENT}`,
    "i",
  ).exec(statement.trim());
  if (!match) {
    return null;
  }
  const table = pick(match, 1);
  const column = pick(match, 6);
  return table && column ? { table, column } : null;
}

function parseCreateViewOrTrigger(
  statement: string,
): { type: "view" | "trigger"; name: string } | null {
  const match = new RegExp(
    String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+)?(VIEW|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`,
    "i",
  ).exec(statement.trim());
  if (!match) {
    return null;
  }
  const name = pick(match, 2);
  return name ? { type: match[1].toLowerCase() as "view" | "trigger", name } : null;
}

/** BEGIN/COMMIT inside a migration file would nest inside our transaction. */
export function isTransactionControlStatement(statement: string): boolean {
  return /^(?:BEGIN|COMMIT|END|ROLLBACK)(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?\s*$/i.test(
    statement.trim(),
  );
}

/** Decide whether `statement` still needs to run against the current schema. */
export async function guardStatement(
  statement: string,
  schema: SchemaInspector,
  options: GuardOptions = {},
): Promise<GuardDecision> {
  const sql = statement.replace(/\s+/g, " ").trim();

  if (isTransactionControlStatement(sql)) {
    return { action: "skip", reason: "transaction control (migration already runs in one transaction)" };
  }

  const renameColumn = /\bRENAME\s+TO\b/i.test(sql) ? null : parseRenameColumnStatement(sql);
  if (renameColumn) {
    const { table, from, to } = renameColumn;
    if (
      (await schema.objectExists("table", table)) &&
      (await schema.columnExists(table, to)) &&
      !(await schema.columnExists(table, from))
    ) {
      return { action: "skip", reason: `${table}.${from} is already renamed to ${to}` };
    }
    return { action: "run" };
  }

  const renameTable = parseRenameTableStatement(sql);
  if (renameTable) {
    if (
      (await schema.objectExists("table", renameTable.to)) &&
      !(await schema.objectExists("table", renameTable.from))
    ) {
      return { action: "skip", reason: `table ${renameTable.from} is already renamed to ${renameTable.to}` };
    }
    return { action: "run" };
  }

  const addColumn = parseAddColumnStatement(sql);
  if (addColumn) {
    const tableExists = await schema.objectExists("table", addColumn.table);
    if (!tableExists && options.skipAddColumnOnMissingTable) {
      return { action: "skip", reason: `table ${addColumn.table} does not exist here` };
    }
    if (tableExists && (await schema.columnExists(addColumn.table, addColumn.column))) {
      return { action: "skip", reason: `${addColumn.table}.${addColumn.column} already exists` };
    }
    return { action: "run" };
  }

  const dropColumn = parseDropColumnStatement(sql);
  if (dropColumn && !/^ALTER\s+TABLE\s+\S+\s+DROP\s+CONSTRAINT\b/i.test(sql)) {
    if (
      !(await schema.objectExists("table", dropColumn.table)) ||
      !(await schema.columnExists(dropColumn.table, dropColumn.column))
    ) {
      return { action: "skip", reason: `${dropColumn.table}.${dropColumn.column} is already gone` };
    }
    return { action: "run" };
  }

  const drop = parseDropStatement(sql);
  if (drop) {
    if (!(await schema.objectExists(drop.objectType, drop.name))) {
      return { action: "skip", reason: `${drop.objectType} ${drop.name} is already gone` };
    }
    return { action: "run" };
  }

  const createTable = parseCreateTableStatement(sql);
  if (createTable && !/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS/i.test(sql)) {
    if (await schema.objectExists("table", createTable.table)) {
      return { action: "skip", reason: `table ${createTable.table} already exists` };
    }
    return { action: "run" };
  }

  const createIndex = parseCreateIndexStatement(sql);
  if (createIndex && !/\bIF\s+NOT\s+EXISTS\b/i.test(sql)) {
    if (await schema.objectExists("index", createIndex.indexName)) {
      return { action: "skip", reason: `index ${createIndex.indexName} already exists` };
    }
    return { action: "run" };
  }

  const viewOrTrigger = parseCreateViewOrTrigger(sql);
  if (viewOrTrigger && !/\bIF\s+NOT\s+EXISTS\b/i.test(sql)) {
    if (await schema.objectExists(viewOrTrigger.type, viewOrTrigger.name)) {
      return { action: "skip", reason: `${viewOrTrigger.type} ${viewOrTrigger.name} already exists` };
    }
    return { action: "run" };
  }

  return { action: "run" };
}
