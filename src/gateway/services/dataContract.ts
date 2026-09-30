/**
 * App data contracts — schema expectations validated after job runs.
 *
 * Stored at ~/Papr/apps/{appId}/data-contract.json
 */

import { existsSync } from "fs";
import { todayBriefDateKey } from "../../core/utils/briefDateKey.js";
import {
  countRowsInRegistryTable,
  queryRegistryDatabase,
  readRegistryDatabaseSchema,
  type RegistryDbSchemaReadInput,
} from "./jobs/registryDbSchemaReader.js";

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
   * column equals today's local calendar date (YYYY-MM-DD).
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

export interface ContractValidationDbContext extends RegistryDbSchemaReadInput {}

function normalizeDbContext(
  dbPathOrContext: string | ContractValidationDbContext,
): ContractValidationDbContext {
  return typeof dbPathOrContext === "string"
    ? { dbPath: dbPathOrContext }
    : dbPathOrContext;
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

async function findInvalidEnumValues(
  db: ContractValidationDbContext,
  table: string,
  column: string,
  allowed: string[],
): Promise<string[]> {
  const allowedSet = new Set(allowed);
  const escapedTable = table.replace(/"/g, "");
  const escapedColumn = column.replace(/"/g, "");
  const result = await queryRegistryDatabase(
    db,
    `SELECT DISTINCT "${escapedColumn}" AS v FROM "${escapedTable}" WHERE "${escapedColumn}" IS NOT NULL`,
  );
  if (!result) {
    return [];
  }
  return result.rows
    .map((row) => String(row.v ?? ""))
    .filter((value) => value.length > 0 && !allowedSet.has(value));
}

export async function validateDatabaseAgainstContract(
  dbPathOrContext: string | ContractValidationDbContext,
  contract: DataContract,
  options?: {
    jobId?: string;
    jobName?: string;
  },
): Promise<ContractValidationResult> {
  const db = normalizeDbContext(dbPathOrContext);
  const violations: ContractViolation[] = [];
  const tablesChecked = new Set<string>();

  if (!existsSync(db.dbPath)) {
    return {
      passed: false,
      violations: [
        {
          severity: "error",
          message: `Primary database not found: ${db.dbPath}`,
        },
      ],
      summary: "Primary database file missing",
      tablesChecked: [],
    };
  }

  const schemaRead = await readRegistryDatabaseSchema(db);
  if (!schemaRead.ok) {
    const severity = schemaRead.code === "locked" ? "warn" : "error";
    return {
      passed: severity !== "error",
      violations: [
        {
          severity,
          message:
            schemaRead.code === "locked"
              ? `Database temporarily locked (${schemaRead.message}); skipped contract validation this run`
              : `Cannot read database: ${schemaRead.message}`,
        },
      ],
      summary:
        schemaRead.code === "locked"
          ? "Contract validation skipped (database busy)"
          : "Database unreadable",
      tablesChecked: [],
    };
  }

  const { tables, columnsByTable } = schemaRead.schema;

  const checkTable = async (
    table: string,
    tableContract: TableContract | undefined,
    minRows: number | undefined,
  ): Promise<void> => {
    tablesChecked.add(table);
    const normalizedTable = table.toLowerCase();

    if (!tables.has(normalizedTable)) {
      violations.push({
        severity: "error",
        message: `Table "${table}" does not exist`,
        table,
      });
      return;
    }

    if (tableContract?.requiredColumns?.length) {
      const columns = columnsByTable.get(normalizedTable) ?? new Set<string>();
      for (const col of tableContract.requiredColumns) {
        if (!columns.has(col.toLowerCase())) {
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
      const count = await countRowsInRegistryTable(db, table);
      if (count === null || count < rowMin) {
        violations.push({
          severity: "error",
          message: `Table "${table}" has ${count ?? 0} rows, expected at least ${rowMin}`,
          table,
        });
      }
    }

    if (tableContract?.enums) {
      for (const [column, allowed] of Object.entries(tableContract.enums)) {
        const invalid = await findInvalidEnumValues(db, table, column, allowed);
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
    await checkTable(table, tableContract, tableContract.minRows);
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
      await checkTable(table, tableContract, minRows);
    }
  }

  if (jobKey && contract.jobs?.[jobKey]?.requireTodayRow) {
    const today = todayBriefDateKey();
    for (const [table, dateColumn] of Object.entries(
      contract.jobs[jobKey].requireTodayRow ?? {},
    )) {
      tablesChecked.add(table);
      const normalizedTable = table.toLowerCase();
      if (!tables.has(normalizedTable)) {
        violations.push({
          severity: "error",
          message: `Table "${table}" does not exist (required today's row)`,
          table,
        });
        continue;
      }
      const col = dateColumn.replace(/"/g, "");
      const escapedTable = table.replace(/"/g, "");
      const result = await queryRegistryDatabase(
        db,
        `SELECT 1 AS ok FROM "${escapedTable}" WHERE "${col}" = ? LIMIT 1`,
        [today],
      );
      if (!result?.rows.length) {
        violations.push({
          severity: "error",
          message: `Table "${table}" has no row for today (${today}) in column "${col}"`,
          table,
          column: col,
        });
      }
    }
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

export async function listUserTablesWithCounts(
  dbPathOrContext: string | ContractValidationDbContext,
): Promise<TableRowCount[]> {
  const db = normalizeDbContext(dbPathOrContext);
  if (!existsSync(db.dbPath)) return [];

  const tableNames = await (async () => {
    const read = await readRegistryDatabaseSchema(db);
    if (!read.ok) {
      return [] as string[];
    }
    return [...read.schema.tables].filter((name) => !name.startsWith("sqlite_"));
  })();

  const counts: TableRowCount[] = [];
  for (const table of tableNames) {
    const count = await countRowsInRegistryTable(db, table);
    if (count !== null) {
      counts.push({ table, count });
    }
  }
  return counts;
}
