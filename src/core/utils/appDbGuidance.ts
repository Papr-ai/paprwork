/**
 * APP_DB vs JOB_DB vs registry guidance for agents debugging app-linked jobs.
 */

export const APP_DB_QUICK_REFERENCE =
  "APP DB quick reference:\n" +
  "- $APP_DB = mini-app primary linked SQLite (UI tables the iframe reads via /api/db/*)\n" +
  "- $JOB_DB = job-local scratch only (run logs, checkpoints) — NOT the mini-app database\n" +
  "- ~/Papr/data/jobs.json = job INDEX (metadata JSON), not SQL — use list_jobs/update_job\n" +
  "- Job files: ~/Papr/orgs/{org}/namespaces/{ns}/Jobs/{jobId}/code/*.py\n" +
  "- Job SQL file: .../Jobs/{jobId}/data/data.db (often same path as $APP_DB when linked)\n" +
  "- Mini-app reads: GET /api/db/query?appId=... (read-only) or POST /api/db/write\n" +
  "- Prefer read_job_logs over bash tail; prefer validate_job + list_job_files over bash find";

const PAPR_JOBS_DB_RE = /\bpapr_jobs\.db\b/i;
const CHATS_DB_RE = /(?:~\/\.paprwork(?:-v2)?\/|\.paprwork(?:-v2)?\/).*chats\.db/i;
const LEGACY_JOBS_DIR_RE = /\/Papr\/jobs\//i;
const JOBS_JSON_SQLITE_RE = /jobs\.json/i;

export function buildAppDbBashGuidance(command: string): string | undefined {
  const hints: string[] = [];

  if (PAPR_JOBS_DB_RE.test(command)) {
    hints.push(
      'papr_jobs.db does not exist. Use $APP_DB for app tables or list_jobs + read_job_file.',
    );
  }

  if (CHATS_DB_RE.test(command) && /sqlite3/i.test(command)) {
    hints.push(
      "chats.db stores chat messages, not job/app business data. Use $APP_DB or /api/db/query.",
    );
  }

  if (LEGACY_JOBS_DIR_RE.test(command) && /sqlite3/i.test(command)) {
    hints.push(
      "Legacy ~/Papr/jobs/ path — active workspace uses ~/Papr/orgs/{org}/namespaces/{ns}/Jobs/{jobId}/.",
    );
  }

  if (JOBS_JSON_SQLITE_RE.test(command) && /sqlite3/i.test(command)) {
    hints.push(
      "jobs.json is JSON metadata, not SQLite. Use list_jobs / update_job, not sqlite3.",
    );
  }

  if (hints.length === 0) {
    return undefined;
  }

  return `⚠️ APP DB GUIDANCE:\n${hints.map((hint) => `- ${hint}`).join("\n")}\n${APP_DB_QUICK_REFERENCE}`;
}

export function buildAppDbJobReminder(
  jobType: string,
  command: string | undefined,
  linkedAppIds: readonly string[],
): string | undefined {
  if (linkedAppIds.length === 0 || !command) {
    return undefined;
  }

  const cmd = command.toUpperCase();
  const mentionsJobDb = cmd.includes("$JOB_DB") || cmd.includes("JOB_DB");
  const mentionsAppDb = cmd.includes("$APP_DB") || cmd.includes("APP_DB");

  if (mentionsJobDb && !mentionsAppDb) {
    return (
      `⚠️ APP DB REMINDER: Job is linked to mini-app(s) but command references JOB_DB without APP_DB. ` +
      `UI-facing tables must use $APP_DB (same file as the app's primary linked DB). ` +
      `JOB_DB is scratch only. ${APP_DB_QUICK_REFERENCE}`
    );
  }

  if (
    (jobType === "agent" || jobType === "subagent") &&
    !mentionsAppDb &&
    /\b(INSERT|UPDATE|DELETE|CREATE TABLE|sqlite3)\b/i.test(command)
  ) {
    return (
      `⚠️ APP DB REMINDER: App-linked job writes SQL but does not mention $APP_DB. ` +
      `Use sqlite3 "$APP_DB" ".tables" or GET /api/db/schema?appId=... before writing UI tables.`
    );
  }

  return undefined;
}

export function buildAppDbRunJobFailureReminder(
  logs: string,
  linkedAppIds: readonly string[],
): string | undefined {
  if (linkedAppIds.length === 0) {
    return undefined;
  }

  const lower = logs.toLowerCase();
  const looksDbRelated =
    lower.includes("no such table") ||
    lower.includes("no such file") ||
    lower.includes("unable to open database") ||
    lower.includes("database is locked") ||
    lower.includes("sqlite3");

  if (!looksDbRelated) {
    return undefined;
  }

  return (
    `⚠️ Job failed with database errors. Before more bash/sqlite debugging:\n` +
    `1. read_job_logs({ jobId }) — you are here\n` +
    `2. validate_job({ jobId })\n` +
    `3. Confirm UI data is in $APP_DB, not $JOB_DB or chats.db\n` +
    `4. Mini-app: GET /api/db/query?appId=... or POST /api/db/exec\n\n` +
    APP_DB_QUICK_REFERENCE
  );
}

export function formatAppDbGuidanceBlock(message: string | undefined): string {
  if (!message) {
    return "";
  }
  return `\n\n=== App database guidance ===\n${message}\n`;
}
