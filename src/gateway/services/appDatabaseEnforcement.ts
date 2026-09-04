/**
 * Detect mini-app database API usage and build validation errors when
 * no job database is linked via data-sources.json.
 */

import { existsSync } from "fs";
import {
  readRegistryDatabaseSchema,
  type RegistryDbSchemaReadInput,
} from "./jobs/registryDbSchemaReader.js";
import {
  extractPrimaryTable,
  JOB_BASELINE_TABLES,
} from "./appDataSources.js";
import type { ValidationIssue } from "./AppService.js";

/** Actual HTTP/import usage — not bare mentions in docs, table cells, or comments. */
const DB_API_USAGE_PATTERNS: readonly RegExp[] = [
  /fetch\s*\(\s*[`'"]\/api\/db\/(query|write|exec|schema)/i,
  /fetch\s*\([^)]{0,400}?\/api\/db\/(query|write|exec|schema)/i,
  /from\s+['"]\.\/db['"]/i,
  /from\s+['"]\.\/db\.ts['"]/i,
];

function stripLineComments(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      ) {
        return "";
      }
      const slash = line.indexOf("//");
      return slash >= 0 ? line.slice(0, slash) : line;
    })
    .join("\n");
}

const MUTATION_KEYWORDS =
  /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+|DELETE\s+FROM|REPLACE\s+INTO|UPSERT\s+INTO)\b/i;

/** SQL string literals near /api/db/query (template, single, or double quoted). */
const DB_QUERY_SQL_LITERAL =
  /\/api\/db\/query[\s\S]{0,800}?(?:sql\s*:\s*)([`'"])([\s\S]*?)\1/gi;

const SQL_TABLE_REFERENCE =
  /\b(?:FROM|INTO|UPDATE|JOIN)\s+["'`]?([a-z_][a-z0-9_]*)["'`]?/gi;

export function appCodeUsesDatabaseApi(content: string): boolean {
  const code = stripLineComments(content);
  return DB_API_USAGE_PATTERNS.some((pattern) => pattern.test(code));
}

export function appFilesUseDatabaseApi(
  fileContents: Map<string, string>,
): boolean {
  for (const content of fileContents.values()) {
    if (appCodeUsesDatabaseApi(content)) {
      return true;
    }
  }
  return false;
}

export function buildMissingDataSourceMessage(appId: string): string {
    return (
    `App uses /api/db/* but no database is linked in data-sources.json. ` +
    `Create a database with create_database, then attach_database({ appId: "${appId}", dbId, alias }). ` +
    `Cloud and desktop DB APIs fail without a linked source.`
  );
}

export function buildMissingDataSourceValidationIssue(appId: string): {
  file: string;
  severity: "error";
  message: string;
  rule: string;
} {
  return {
    file: "data-sources.json",
    severity: "error",
    message: buildMissingDataSourceMessage(appId),
    rule: "linked-data-source-required",
  };
}

function isFrontendSource(relativePath: string): boolean {
  if (
    relativePath.startsWith("backend/") ||
    relativePath.startsWith("backend\\")
  ) {
    return false;
  }
  return /\.(ts|tsx|js|jsx|html)$/.test(relativePath);
}

/**
 * Detect INSERT/UPDATE/DELETE sent to read-only /api/db/query (gateway returns 403).
 */
export function checkDbQueryWriteAntiPattern(
  fileContents: Map<string, string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [filename, content] of fileContents.entries()) {
    if (!isFrontendSource(filename)) {
      continue;
    }

    DB_QUERY_SQL_LITERAL.lastIndex = 0;
    for (const match of content.matchAll(DB_QUERY_SQL_LITERAL)) {
      const sql = match[2] ?? "";
      if (!MUTATION_KEYWORDS.test(sql)) {
        continue;
      }
      const table = extractPrimaryTable(sql);
      issues.push({
        file: filename,
        severity: "error",
        message:
          `Mutation SQL sent to /api/db/query (returns 403). Use POST /api/db/write for INSERT/UPDATE/DELETE` +
          (table ? ` on "${table}"` : "") +
          `. Call GET /api/db/schema?appId=... first if unsure tables exist.`,
        rule: "db-query-write-forbidden",
      });
    }

    if (
      /\/api\/db\/query\b/i.test(content) &&
      /\/api\/db\/write\b/i.test(content) === false &&
      MUTATION_KEYWORDS.test(content)
    ) {
      const alreadyReported = issues.some((issue) => issue.file === filename);
      if (!alreadyReported) {
        issues.push({
          file: filename,
          severity: "warning",
          message:
            "File may send mutations via /api/db/query — gateway allows SELECT only on that endpoint. Use /api/db/write for INSERT/UPDATE/DELETE.",
          rule: "db-query-write-suspected",
        });
      }
    }
  }

  return issues;
}

export function extractReferencedAppTables(
  fileContents: Map<string, string>,
): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();

  for (const [filename, content] of fileContents.entries()) {
    if (!appCodeUsesDatabaseApi(content)) {
      continue;
    }

    const tables = new Set<string>();
    const sqlLiterals: string[] = [];

    DB_QUERY_SQL_LITERAL.lastIndex = 0;
    for (const match of content.matchAll(DB_QUERY_SQL_LITERAL)) {
      sqlLiterals.push(match[2] ?? "");
    }

    const writeLiteral =
      /\/api\/db\/write[\s\S]{0,800}?(?:sql\s*:\s*)([`'"])([\s\S]*?)\1/gi;
    writeLiteral.lastIndex = 0;
    for (const match of content.matchAll(writeLiteral)) {
      sqlLiterals.push(match[2] ?? "");
    }

    for (const sql of sqlLiterals) {
      const primary = extractPrimaryTable(sql);
      if (primary && !JOB_BASELINE_TABLES.has(primary)) {
        tables.add(primary);
      }
      SQL_TABLE_REFERENCE.lastIndex = 0;
      for (const ref of sql.matchAll(SQL_TABLE_REFERENCE)) {
        const name = ref[1];
        if (name && !JOB_BASELINE_TABLES.has(name)) {
          tables.add(name);
        }
      }
    }

    if (tables.size > 0) {
      byFile.set(filename, tables);
    }
  }

  return byFile;
}

async function listTablesOnDb(
  dbPath: string,
  context?: Omit<RegistryDbSchemaReadInput, "dbPath">,
): Promise<Set<string>> {
  if (!existsSync(dbPath)) {
    return new Set();
  }
  const read = await readRegistryDatabaseSchema({
    dbPath,
    ...context,
  });
  if (!read.ok) {
    return new Set();
  }
  return new Set(
    [...read.schema.tables].filter((name) => !name.startsWith("sqlite_")),
  );
}

/**
 * Warn when app SQL references tables missing from the primary linked DB.
 */
export async function checkMissingTablesOnPrimaryDb(
  primaryDbPath: string,
  fileContents: Map<string, string>,
  context?: Omit<RegistryDbSchemaReadInput, "dbPath">,
): Promise<ValidationIssue[]> {
  const referenced = extractReferencedAppTables(fileContents);
  if (referenced.size === 0) {
    return [];
  }

  const existing = await listTablesOnDb(primaryDbPath, context);
  const issues: ValidationIssue[] = [];
  const missingGlobal = new Set<string>();

  for (const [filename, tables] of referenced.entries()) {
    for (const table of tables) {
      if (existing.has(table)) {
        continue;
      }
      missingGlobal.add(table);
      issues.push({
        file: filename,
        severity: "error",
        message:
          `SQL references table "${table}" but it is missing from primary DB (${primaryDbPath}). ` +
          `Bootstrap with POST /api/db/exec (CREATE TABLE IF NOT EXISTS), run a backend migrate action, ` +
          `or add backend/migrate.py to backend/manifest.json and call POST /api/app/backend/migrate.`,
        rule: "db-table-missing-on-primary",
      });
    }
  }

  if (missingGlobal.size > 0 && !fileContents.has("data-contract.json")) {
    issues.push({
      file: "data-contract.json",
      severity: "warning",
      message:
        `App references tables (${[...missingGlobal].join(", ")}) — consider adding data-contract.json ` +
        `and enforceOnFailure after schema bootstrap so post-job validation catches drift.`,
      rule: "data-contract-recommended",
    });
  }

  return issues;
}
