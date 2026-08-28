/**
 * App data contracts — schema expectations validated after job runs.
 *
 * Stored at ~/Papr/apps/{appId}/data-contract.json
 */

import Database from "better-sqlite3";
import { existsSync } from "fs";

export interface TableContract {
  /** Columns that must exist (PRAGMA table_info). */
  requiredColumns?: string[];
  /** Allowed values per column — any row with a different value fails validation. */
  enums?: Record<string, string[]>;
  /** Minimum row count required in this table. */
  minRows?: number;
  /** Documentation for agents: UI/query name → actual column name. */
  columnAliases?: Record<string, string>;
}

export interface JobContractCheck {
  /** table → minimum rows after this job completes successfully. */
  minRows?: Record<string, number>;
  /**
   * table → date column name. After a successful run, require a row where the
   * column equals today's UTC date (YYYY-MM-DD).
   */
  requireTodayRow?: Record<string, string>;
}

export interface DataContract {
  version: number;
  /** Should match data-sources.json primary alias. */
  primarySource?: string;
  /**
   * When true, a failed post-job validation marks the job as failed.
   * Default false — violations are logged as [Contract] WARNING only (backwards compatible).
   */
  enforceOnFailure?: boolean;
  tables?: Record<string, TableContract>;
  /** Keyed by job name or job id. */
  jobs?: Record<string, JobContractCheck>;
}

export type ContractViolationSeverity = "error" | "warn";

export interface ContractViolation {
  severity: ContractViolationSeverity;
  message: string;
  table?: string;
  column?: string;
}

export interface ContractValidationResult {
  passed: boolean;
  violations: ContractViolation[];
  summary: string;
  tablesChecked: string[];
}

export function parseDataContract(raw: string): DataContract {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("data-contract.json must be a JSON object");
  }
  const contract = parsed as DataContract;
  if (typeof contract.version !== "number") {
    throw new Error('data-contract.json requires numeric "version" field');
  }
  return contract;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
    )
    .get(table) as { name: string } | undefined;
  return !!row;
}

function getColumnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table.replace(/"/g, "")}")`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function countRows(db: Database.Database, table: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM "${table.replace(/"/g, "")}"`)
    .get() as { c: number };
  return row.c;
}

function findInvalidEnumValues(
  db: Database.Database,
  table: string,
  column: string,
  allowed: string[],
): string[] {
  const allowedSet = new Set(allowed);
  const rows = db
    .prepare(
      `SELECT DISTINCT "${column.replace(/"/g, "")}" AS v FROM "${table.replace(/"/g, "")}" WHERE "${column.replace(/"/g, "")}" IS NOT NULL`,
    )
    .all() as Array<{ v: string }>;
  return rows.map((r) => String(r.v)).filter((v) => !allowedSet.has(v));
}

export function validateDatabaseAgainstContract(
  dbPath: string,
  contract: DataContract,
  options?: {
    jobId?: string;
    jobName?: string;
  },
): ContractValidationResult {
  const violations: ContractViolation[] = [];
  const tablesChecked = new Set<string>();

  if (!existsSync(dbPath)) {
    return {
      passed: false,
      violations: [
        {
          severity: "error",
          message: `Primary database not found: ${dbPath}`,
        },
      ],
      summary: "Primary database file missing",
      tablesChecked: [],
    };
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    return {
      passed: false,
      violations: [
        {
          severity: "error",
          message: `Cannot open database: ${(err as Error).message}`,
        },
      ],
      summary: "Database unreadable",
      tablesChecked: [],
    };
  }

  try {
    const checkTable = (table: string, tableContract: TableContract | undefined, minRows: number | undefined) => {
      tablesChecked.add(table);

      if (!tableExists(db, table)) {
        violations.push({
          severity: "error",
          message: `Table "${table}" does not exist`,
          table,
        });
        return;
      }

      if (tableContract?.requiredColumns?.length) {
        const columns = getColumnNames(db, table);
        for (const col of tableContract.requiredColumns) {
          if (!columns.has(col)) {
            violations.push({
              severity: "error",
              message: `Table "${table}" missing required column "${col}"`,
              table,
              column: col,
            });
          }
        }
      }

      const rowMin = minRows ?? tableContract?.minRows;
      if (rowMin !== undefined && rowMin > 0) {
        const count = countRows(db, table);
        if (count < rowMin) {
          violations.push({
            severity: "error",
            message: `Table "${table}" has ${count} rows, expected at least ${rowMin}`,
            table,
          });
        }
      }

      if (tableContract?.enums) {
        for (const [column, allowed] of Object.entries(tableContract.enums)) {
          const invalid = findInvalidEnumValues(db, table, column, allowed);
          if (invalid.length > 0) {
            const sample = invalid.slice(0, 5).join(", ");
            violations.push({
              severity: "error",
              message: `Table "${table}" column "${column}" has invalid values: ${sample}${invalid.length > 5 ? "…" : ""}. Allowed: ${allowed.join(", ")}`,
              table,
              column,
            });
          }
        }
      }
    };

    for (const [table, tableContract] of Object.entries(contract.tables ?? {})) {
      checkTable(table, tableContract, tableContract.minRows);
    }

    const jobKey =
      (options?.jobName && contract.jobs?.[options.jobName]
        ? options.jobName
        : undefined) ??
      (options?.jobId && contract.jobs?.[options.jobId]
        ? options.jobId
        : undefined);

    if (jobKey && contract.jobs?.[jobKey]?.minRows) {
      for (const [table, minRows] of Object.entries(
        contract.jobs[jobKey].minRows ?? {},
      )) {
        const tableContract = contract.tables?.[table];
        checkTable(table, tableContract, minRows);
      }
    }

    if (jobKey && contract.jobs?.[jobKey]?.requireTodayRow) {
      const today = new Date().toISOString().slice(0, 10);
      for (const [table, dateColumn] of Object.entries(
        contract.jobs[jobKey].requireTodayRow ?? {},
      )) {
        tablesChecked.add(table);
        if (!tableExists(db, table)) {
          violations.push({
            severity: "error",
            message: `Table "${table}" does not exist (required today's row)`,
            table,
          });
          continue;
        }
        const col = dateColumn.replace(/"/g, "");
        const row = db
          .prepare(
            `SELECT 1 AS ok FROM "${table.replace(/"/g, "")}" WHERE "${col}" = ? LIMIT 1`,
          )
          .get(today) as { ok: number } | undefined;
        if (!row) {
          violations.push({
            severity: "error",
            message: `Table "${table}" has no row for today (${today}) in column "${col}"`,
            table,
            column: col,
          });
        }
      }
    }
  } finally {
    db.close();
  }

  const errors = violations.filter((v) => v.severity === "error");
  const passed = errors.length === 0;
  const summary = passed
    ? `Contract OK (${tablesChecked.size} table(s) checked)`
    : `Contract failed: ${errors.map((e) => e.message).join("; ")}`;

  return {
    passed,
    violations,
    summary,
    tablesChecked: [...tablesChecked],
  };
}

export interface TableRowCount {
  table: string;
  count: number;
}

export function listUserTablesWithCounts(dbPath: string): TableRowCount[] {
  if (!existsSync(dbPath)) return [];

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }

  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    return tables.map(({ name }) => ({
      table: name,
      count: countRows(db, name),
    }));
  } finally {
    db.close();
  }
}
