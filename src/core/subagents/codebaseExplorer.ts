/**
 * Built-in "codebase-explorer" sub-agent: cheap, read-only investigation handoff to the main agent.
 */

export const CODEBASE_EXPLORER_SUB_AGENT_ID = "codebase-explorer";

/** Main-agent wake-up excerpt after exploration delegations (default sub-agents use 4K). */
export const EXPLORATION_DELEGATION_RESULT_EXCERPT_CHARS = 48_000;

export function resolveDelegationResultExcerptChars(
  subAgentId: string | undefined,
): number {
  if (subAgentId?.trim() === CODEBASE_EXPLORER_SUB_AGENT_ID) {
    return EXPLORATION_DELEGATION_RESULT_EXCERPT_CHARS;
  }
  return 4_000;
}

/** Read/query tools only — no writes, no create_app/create_job. */
export const CODEBASE_EXPLORER_TOOL_IDS: readonly string[] = [
  "bash",
  "read_file",
  "search_files",
  "read_app_file",
  "list_app_files",
  "list_apps",
  "list_jobs",
  "read_job_file",
  "read_job_logs",
  "get_job_history",
  "get_job_stats",
  "query_cloud_turso",
  "papr_db_sync_status",
  "read_app_data_health",
  "read_app_data_sources",
  "get_project_code_overview",
  "list_file_code_summaries",
  "get_file_code_summary",
  "search_agent_memory",
  "complete_delegation",
];

export const CODEBASE_EXPLORER_HANDOFF_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "recommendedNextSteps"],
  properties: {
    summary: { type: "string", description: "2-4 sentences for the main agent" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          lineRefs: { type: "array", items: { type: "string" } },
          jobIds: { type: "array", items: { type: "string" } },
          appIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    snippets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "excerpt"],
        properties: {
          path: { type: "string" },
          lines: { type: "string" },
          excerpt: { type: "string" },
        },
      },
    },
    uncertainties: { type: "array", items: { type: "string" } },
    recommendedNextSteps: { type: "array", items: { type: "string" } },
  },
} as const;

export function buildCodebaseExplorerSystemPrompt(maxTurns: number): string {
  return `You are the Paprwork Codebase Explorer sub-agent. You investigate — you do NOT implement fixes.

SCOPE:
- Gather evidence from repo files, mini-apps, jobs, logs, and cloud/registry DBs (read-only).
- Do NOT call write_file, edit_*, create_app, create_job, run_job, or mutate data.
- bash: grep/find/cat/head only — no installs, no destructive commands.

WORKFLOW:
1. Restate the investigation goal in one sentence.
2. list_apps / list_jobs when IDs are unknown.
3. Prefer read_app_file / read_file / read_job_file over huge bash dumps.
4. For registry DBs: query_cloud_turso, papr_db_sync_status, read_app_data_health — never sqlite3 on registry paths.
5. Stop calling tools once you have enough evidence; deliver the handoff in your final message.

OUTPUT (required — your final assistant message is delivered to the main agent):
## Summary
## Findings (bullet list with paths, jobIds, line refs)
## Key snippets (short quotes — not full files)
## Uncertainties
## Recommended next steps (what the main agent should do — not what you will do)

Then append a fenced JSON block matching this shape (valid JSON):
\`\`\`json
{
  "summary": "...",
  "findings": [{ "title": "...", "detail": "...", "paths": [], "lineRefs": [], "jobIds": [], "appIds": [] }],
  "snippets": [{ "path": "...", "lines": "10-40", "excerpt": "..." }],
  "uncertainties": [],
  "recommendedNextSteps": ["..."]
}
\`\`\`

TURN BUDGET: Up to ${maxTurns} tool steps. After investigation, STOP and publish the full handoff — no "I will now..." without delivering.`;
}
