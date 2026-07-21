import { JOB_BASELINE_TABLES } from "../appDataSources.js";
import { STANDALONE_APP_ID } from "./appIds.js";

export type JobArchitectureSeverity = "error" | "warning";

export interface JobArchitectureIssue {
  rule: string;
  severity: JobArchitectureSeverity;
  message: string;
  remediation: string;
}

export interface JobArchitectureInput {
  type: string;
  command?: string;
  appIds?: readonly string[];
}

const MUTATION =
  "(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO|CREATE\\s+TABLE|DROP\\s+TABLE|ALTER\\s+TABLE)";
const NON_PORTABLE_JOB_PATH = /(?:\/Users\/[^/\s"']+|~)\/Papr\/Jobs\//i;
const JOBS_INDEX_ACCESS = /(?:jobs\.json|job\.json)/i;
const LOCAL_GATEWAY_WRITE =
  /(?:localhost|127\.0\.0\.1)[^\n]{0,160}\/api\/db\/write|\/api\/db\/write[^\n]{0,160}(?:localhost|127\.0\.0\.1)/i;

function hasLinkedApp(appIds: readonly string[] | undefined): boolean {
  return (appIds ?? []).some((id) => id !== STANDALONE_APP_ID);
}

function extractMutatedTables(text: string): string[] {
  const tables = new Set<string>();
  const suffix =
    "\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?[\\\"']?([A-Za-z_][\\w$]*)";
  const pattern = new RegExp(MUTATION + suffix, "gi");
  for (const match of text.matchAll(pattern))
    tables.add(match[1].toLowerCase());
  return [...tables];
}

export function validateJobArchitecture(
  input: JobArchitectureInput,
): JobArchitectureIssue[] {
  const text = input.command ?? "";
  if (!text.trim()) return [];

  const issues: JobArchitectureIssue[] = [];
  const queryWrite = new RegExp(
    `\\/api\\/db\\/query[\\s\\S]{0,1200}?${MUTATION}|${MUTATION}[\\s\\S]{0,1200}?\\/api\\/db\\/query`,
    "i",
  );

  if (queryWrite.test(text)) {
    issues.push({
      rule: "job-db-query-write-forbidden",
      severity: "error",
      message:
        "Job attempts a SQL mutation through /api/db/query, which is read-only.",
      remediation:
        "App-linked jobs should write directly to $APP_DB. Mini-app iframe code should use /api/db/write.",
    });
  }

  if (NON_PORTABLE_JOB_PATH.test(text)) {
    issues.push({
      rule: "job-hardcoded-user-path",
      severity: "error",
      message:
        "Job contains a machine-specific ~/Papr/Jobs or /Users/.../Papr/Jobs path.",
      remediation:
        "Use $JOB_DIR, $JOB_DB, $APP_DB, or declared dependency environment variables.",
    });
  }

  if (/Papr\/Jobs\//i.test(text) && JOBS_INDEX_ACCESS.test(text)) {
    issues.push({
      rule: "job-cross-job-filesystem-access",
      severity: "error",
      message:
        "Job reads Papr job metadata or another job through the Jobs filesystem.",
      remediation:
        "Pass data through $APP_DB, a declared dependency DB, or structured job output instead of job.json/jobs.json files.",
    });
  }

  if (hasLinkedApp(input.appIds) && /\$\{?JOB_DB\}?/i.test(text)) {
    const nonScratchTables = extractMutatedTables(text).filter(
      (table) => !JOB_BASELINE_TABLES.has(table),
    );
    if (nonScratchTables.length > 0) {
      issues.push({
        rule: "job-ui-table-on-job-db",
        severity: "error",
        message: `App-linked job mutates non-scratch table(s) through $JOB_DB: ${nonScratchTables.join(", ")}.`,
        remediation:
          "Use $APP_DB for tables consumed by the mini-app. Reserve $JOB_DB for run logs, checkpoints, and temporary state.",
      });
    }
  }

  if (hasLinkedApp(input.appIds) && LOCAL_GATEWAY_WRITE.test(text)) {
    issues.push({
      rule: "job-desktop-api-dependency",
      severity: "error",
      message:
        "App-linked job writes through a localhost /api/db/write endpoint, which is not portable to cloud execution.",
      remediation:
        "Write directly to the injected $APP_DB path from the job runtime.",
    });
  }

  return issues;
}

export function formatJobArchitectureErrors(
  issues: readonly JobArchitectureIssue[],
): string {
  return issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `[${issue.rule}] ${issue.message} ${issue.remediation}`)
    .join("\n");
}
