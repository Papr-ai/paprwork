/**
 * Detect mini-app database API usage and build validation errors when
 * no job database is linked via data-sources.json.
 */

const DB_API_PATTERNS: readonly RegExp[] = [
  /\/api\/db\/query\b/i,
  /\/api\/db\/write\b/i,
  /\/api\/db\/exec\b/i,
  /\/api\/db\/schema\b/i,
  /from\s+['"]\.\/db['"]/i,
  /from\s+['"]\.\/db\.ts['"]/i,
];

export function appCodeUsesDatabaseApi(content: string): boolean {
  return DB_API_PATTERNS.some((pattern) => pattern.test(content));
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
    `Create a database with create_database, attach via attach_database({ appId: "${appId}", dbId, setPrimary: true }), ` +
    `or link a job DB with link_app_data_source({ appId: "${appId}", jobId, setPrimary: true }). ` +
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
