/**
 * APP_DB / PAPR_DB_* / JOB_DB guidance for agents debugging app-linked jobs.
 */

export const APP_DB_QUICK_REFERENCE =
  "Database quick reference:\n" +
  "- create_database → attach_database({ appId, dbId, alias }) → app uses sourceId on /api/db/*\n" +
  "- Mini-app reads: POST /api/db/query with { appId, sourceId, sql, params }\n" +
  "- Mini-app writes: POST /api/db/write with { appId, sourceId, sql, params } — all linked DBs are writable\n" +
  "- Mini-app identity: GET /api/access → { isOwner, mode, canRead, canWrite, userId?, email? } — gate admin UI; map userId to roles\n" +
  "- Anonymous apps: owner_session column + localStorage UUID; multi-user: sign-in + papr_user_id or isolation: per-user\n" +
  "- App backend: sourceId on manifest → papr_db.connect(\"alias\") — never sqlite3.connect (cloud = Turso)\n" +
  "- Jobs: create_job({ writeDbIds: [dbId] }) → PAPR_DB_{ALIAS} env vars for job scripts\n" +
  "- APP_DB = active source (backend) or first write target (jobs, legacy)\n" +
  "- $JOB_DB = job-local scratch only (run logs, checkpoints) — NOT mini-app data\n" +
  "- Prefer read_job_logs over bash tail; prefer validate_job + list_job_files over bash find";

const PAPR_JOBS_DB_RE = /\bpapr_jobs\.db\b/i;
const CHATS_DB_RE = /(?:~\/\.paprwork(?:-v2)?\/|\.paprwork(?:-v2)?\/).*chats\.db/i;
const LEGACY_JOBS_DIR_RE = /\/Papr\/jobs\//i;
const JOBS_JSON_SQLITE_RE = /jobs\.json/i;

const PERSIST_INTENT_RE =
  /\b(save|store|persist|write|insert|update|database|table|rows|results|insights|sync|record)\b/i;

export function buildAppDbBashGuidance(command: string): string | undefined {
  const hints: string[] = [];

  if (PAPR_JOBS_DB_RE.test(command)) {
    hints.push(
      'papr_jobs.db does not exist. Use PAPR_DB_* / APP_DB or list_jobs + read_job_file.',
    );
  }

  if (CHATS_DB_RE.test(command) && /sqlite3/i.test(command)) {
    hints.push(
      "chats.db stores chat messages, not job/app business data. Use PAPR_DB_* or /api/db/query.",
    );
  }

  if (LEGACY_JOBS_DIR_RE.test(command) && /sqlite3/i.test(command)) {
    hints.push(
      "Legacy flat Papr jobs path — active workspace uses $PAPR_HOME/Jobs/{jobId}/.",
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
  writeDbIds: readonly string[] = [],
): string | undefined {
  if (linkedAppIds.length === 0 && writeDbIds.length === 0) {
    return undefined;
  }
  if (!command) {
    return undefined;
  }

  const cmd = command.toUpperCase();
  const mentionsJobDb = cmd.includes("$JOB_DB") || cmd.includes("JOB_DB");
  const mentionsWriteDb =
    cmd.includes("$APP_DB") ||
    cmd.includes("APP_DB") ||
    cmd.includes("PAPR_DB_");

  const isAgentJob = jobType === "agent" || jobType === "subagent";

  if (mentionsJobDb && !mentionsWriteDb && writeDbIds.length > 0) {
    return (
      `⚠️ APP DB REMINDER: Job has writeDbIds but command references JOB_DB without PAPR_DB_* / APP_DB. ` +
      `UI-facing tables must use PAPR_DB_* env vars from writeDbIds. JOB_DB is scratch only. ${APP_DB_QUICK_REFERENCE}`
    );
  }

  if (
    isAgentJob &&
    writeDbIds.length > 0 &&
    PERSIST_INTENT_RE.test(command) &&
    !mentionsWriteDb
  ) {
    return (
      `⚠️ APP DB REMINDER: Agent job will persist data — use PAPR_DB_* / APP_DB at runtime (papr_db_exec or sqlite3), NOT $JOB_DB. ` +
      `writeDbIds: ${writeDbIds.join(", ")}. $JOB_DB is scratch only and invisible to mini-apps. ${APP_DB_QUICK_REFERENCE}`
    );
  }

  if (
    isAgentJob &&
    linkedAppIds.length > 0 &&
    writeDbIds.length === 0 &&
    PERSIST_INTENT_RE.test(command)
  ) {
    return (
      `⚠️ APP DB REMINDER: App-linked agent job implies persisting data but has no writeDbIds. ` +
      `create_database → attach_database → create_job({ writeDbIds: [dbId] }). ` +
      `Without writeDbIds the agent may write to $JOB_DB scratch, which the mini-app cannot read. ${APP_DB_QUICK_REFERENCE}`
    );
  }

  if (
    writeDbIds.length === 0 &&
    isAgentJob &&
    !mentionsWriteDb &&
    /\b(INSERT|UPDATE|DELETE|CREATE TABLE|sqlite3)\b/i.test(command)
  ) {
    return (
      `⚠️ APP DB REMINDER: Job writes SQL but has no writeDbIds. ` +
      `Set writeDbIds on create_job/update_job after create_database + attach_database. ${APP_DB_QUICK_REFERENCE}`
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
    `3. Confirm writes use PAPR_DB_* / writeDbIds, not $JOB_DB alone\n` +
    `4. Mini-app: POST /api/db/query or /api/db/write with sourceId\n` +
    `5. App backend: manifest sourceId or params.sourceId → papr_db.connect("alias")\n\n` +
    APP_DB_QUICK_REFERENCE
  );
}

export function formatAppDbGuidanceBlock(message: string | undefined): string {
  if (!message) {
    return "";
  }
  return `\n\n=== App database guidance ===\n${message}\n`;
}
