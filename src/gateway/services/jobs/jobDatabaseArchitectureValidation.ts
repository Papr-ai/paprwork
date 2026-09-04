import type { JobArchitectureIssue } from "./jobArchitectureValidation.js";
import type { DatabaseSyncMode } from "../tursoReplica/tursoReplicaTypes.js";
import {
  readRegistryDatabaseSchema,
  type RegistryDbSchemaReadErrorCode,
} from "./registryDbSchemaReader.js";

export interface DataContractTable {
  requiredColumns?: string[];
  writers?: string[];
  readers?: string[];
}

export interface AppDataContract {
  version?: number;
  tables?: Record<string, DataContractTable>;
}

export interface JobDatabaseValidationInput {
  command?: string;
  databasePath: string;
  dbId?: string;
  alias?: string;
  syncMode?: DatabaseSyncMode;
  contract?: AppDataContract | null;
  /** agent/subagent commands are natural-language prompts, not SQL */
  jobType?: string;
}

const AGENT_LIKE_JOB_TYPES = new Set(["agent", "subagent"]);

/** Pull SQL out of sqlite3 invocations / explicit DDL — not from prose instructions. */
export function extractSqlSnippetsFromJobCommand(command: string): string {
  const snippets: string[] = [];

  for (const match of command.matchAll(
    /sqlite3\s+(?:\$APP_DB|\$PAPR_DB_\w+|\$\{[^}]+\}|"[^"]+"|'[^']+')\s+(['"])([\s\S]*?)\1/gi,
  )) {
    snippets.push(match[2]);
  }

  for (const match of command.matchAll(
    /(?:^|[;\n])\s*(CREATE\s+TABLE[\s\S]*?;|ALTER\s+TABLE[\s\S]*?;|INSERT\s+INTO[\s\S]*?;|UPDATE[\s\S]*?;|DELETE\s+FROM[\s\S]*?;)/gi,
  )) {
    snippets.push(match[1].trim());
  }

  return snippets.join("\n");
}

function shouldScanCommandForSql(input: JobDatabaseValidationInput): boolean {
  if (input.jobType && AGENT_LIKE_JOB_TYPES.has(input.jobType)) {
    return false;
  }
  return true;
}

const TABLE_REFERENCE =
  /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+["'`]?([A-Za-z_][\w$]*)/gi;
const CREATED_TABLE =
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][\w$]*)/gi;
const INSERT_COLUMNS =
  /\b(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+["'`]?([A-Za-z_][\w$]*)["'`]?\s*\(([^)]+)\)/gi;
const UPDATE_COLUMNS =
  /\bUPDATE\s+["'`]?([A-Za-z_][\w$]*)["'`]?\s+SET\s+([\s\S]{1,1000}?)(?:\bWHERE\b|;|$)/gi;
const ADDED_COLUMN =
  /\bALTER\s+TABLE\s+["'`]?([A-Za-z_][\w$]*)["'`]?\s+ADD\s+(?:COLUMN\s+)?["'`]?([A-Za-z_][\w$]*)/gi;

function names(pattern: RegExp, text: string): Set<string> {
  const result = new Set<string>();
  for (const match of text.matchAll(pattern)) result.add(match[1].toLowerCase());
  return result;
}

function referencedColumns(text: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    const key = table.toLowerCase();
    const columns = result.get(key) ?? new Set<string>();
    columns.add(column.replace(/^["'`]|["'`]$/g, "").trim().toLowerCase());
    result.set(key, columns);
  };
  for (const match of text.matchAll(INSERT_COLUMNS)) {
    for (const column of match[2].split(",")) add(match[1], column);
  }
  for (const match of text.matchAll(UPDATE_COLUMNS)) {
    for (const assignment of match[2].split(",")) {
      const column = assignment.match(/^\s*["'`]?([A-Za-z_][\w$]*)["'`]?\s*=/)?.[1];
      if (column) add(match[1], column);
    }
  }
  return result;
}

function schemaReadIssue(
  databasePath: string,
  code: RegistryDbSchemaReadErrorCode,
  message: string,
): JobArchitectureIssue[] {
  if (code === "missing") {
    return [
      {
        rule: "primary-database-missing",
        severity: "error",
        message: `Primary app database not found at ${databasePath}.`,
        remediation:
          "Restart Paprwork to auto-repair data-sources.json paths after workspace migration, or re-link the job with link_app_data_source({ appId, jobId }).",
      },
    ];
  }

  if (code === "locked") {
    return [
      {
        rule: "primary-database-busy",
        severity: "warning",
        message: `Primary app database at ${databasePath} is temporarily locked (${message}). Skipping schema validation this run.`,
        remediation:
          "This is usually transient while Turso replica sync is active. The job will retry on the next schedule tick.",
      },
    ];
  }

  if (code === "unreadable") {
    return [
      {
        rule: "primary-database-unopenable",
        severity: "error",
        message: `Cannot read primary app database at ${databasePath}: ${message}`,
        remediation:
          "The linked file is not a valid SQLite database. Re-link the job with link_app_data_source({ appId, jobId }), or recreate the database with create_database.",
      },
    ];
  }

  return [
    {
      rule: "primary-database-unopenable",
      severity: "error",
      message: `Cannot open primary app database at ${databasePath}: ${message}`,
      remediation:
        "Restart Paprwork to auto-repair data-sources.json paths after workspace migration, or re-link the job with link_app_data_source({ appId, jobId }).",
    },
  ];
}

export async function validateJobAgainstAppDatabase(
  input: JobDatabaseValidationInput,
): Promise<JobArchitectureIssue[]> {
  const scanCommand = shouldScanCommandForSql(input);
  const text = scanCommand
    ? extractSqlSnippetsFromJobCommand(input.command ?? "")
    : "";
  const issues: JobArchitectureIssue[] = [];

  const schemaRead = await readRegistryDatabaseSchema({
    dbPath: input.databasePath,
    dbId: input.dbId,
    alias: input.alias,
    syncMode: input.syncMode,
  });

  if (!schemaRead.ok) {
    return schemaReadIssue(input.databasePath, schemaRead.code, schemaRead.message);
  }

  const { tables, columnsByTable: existingColumnsByTable } = schemaRead.schema;
  const created = names(CREATED_TABLE, text);
  const referenced = names(TABLE_REFERENCE, text);
  const columnsByTable = referencedColumns(text);
  const addedColumns = new Map<string, Set<string>>();
  for (const match of text.matchAll(ADDED_COLUMN)) {
    const table = match[1].toLowerCase();
    const columns = addedColumns.get(table) ?? new Set<string>();
    columns.add(match[2].toLowerCase());
    addedColumns.set(table, columns);
  }

  for (const table of referenced) {
    if (!scanCommand || !text.trim()) continue;
    if (!tables.has(table) && !created.has(table)) {
      issues.push({
        rule: "job-table-missing-on-primary",
        severity: "error",
        message: `Job references table "${table}" but it is missing from the primary app database.`,
        remediation: "Add and run a registered migration before creating or updating this job.",
      });
    }
  }

  const checkedTables = new Set([
    ...columnsByTable.keys(),
    ...Object.keys(input.contract?.tables ?? {}).map((name) => name.toLowerCase()),
  ]);
  for (const table of checkedTables) {
    if (!tables.has(table)) continue;
    const existingColumns = existingColumnsByTable.get(table) ?? new Set<string>();
    if (scanCommand && text.trim()) {
      const referencedColumnsForTable = columnsByTable.get(table) ?? new Set<string>();
      for (const column of referencedColumnsForTable) {
        if (!existingColumns.has(column) && !addedColumns.get(table)?.has(column)) {
          issues.push({
            rule: "job-column-missing-on-primary",
            severity: "error",
            message: `Job writes column "${table}.${column}" but it is missing from the primary app database.`,
            remediation:
              "Use the canonical column name or add and run a migration before updating the job.",
          });
        }
      }
    }
    const contractTable = Object.entries(input.contract?.tables ?? {}).find(
      ([name]) => name.toLowerCase() === table,
    )?.[1];
    for (const column of contractTable?.requiredColumns ?? []) {
      if (
        !existingColumns.has(column.toLowerCase()) &&
        !addedColumns.get(table)?.has(column.toLowerCase())
      ) {
        issues.push({
          rule: "data-contract-column-missing",
          severity: "error",
          message: `Data contract requires "${table}.${column}" but the primary database does not contain it.`,
          remediation: "Run the app migration or update data-contract.json to match the intended schema.",
        });
      }
    }
  }

  for (const table of Object.keys(input.contract?.tables ?? {})) {
    if (!tables.has(table.toLowerCase()) && !created.has(table.toLowerCase())) {
      issues.push({
        rule: "data-contract-table-missing",
        severity: "error",
        message: `Data contract requires table "${table}" but the primary database does not contain it.`,
        remediation: "Run the registered migration before running app-linked jobs.",
      });
    }
  }

  return issues;
}
