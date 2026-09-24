/**
 * Canonical ids for cloud app contribute-back (GitHub PR) agent tools.
 * Not for local app editing, inspect_cloud_repo (default branch), or push_cloud_sync.
 */

export const CLOUD_APP_PR_TOOL_IDS = {
  check: "check_cloud_app_contributions",
  list: "list_cloud_app_prs",
  review: "get_cloud_app_pr_review",
  readFile: "read_cloud_app_pr_file",
  resolve: "resolve_cloud_app_pr",
  submit: "submit_cloud_app_pr",
} as const;

/** Legacy ids from early contribute-back naming — resolved in ToolRegistry.getTool. */
export const CLOUD_APP_PR_TOOL_LEGACY_ALIASES: Readonly<Record<string, string>> = {
  submit_cloud_app_change: CLOUD_APP_PR_TOOL_IDS.submit,
  list_cloud_app_changes: CLOUD_APP_PR_TOOL_IDS.list,
  resolve_cloud_app_change: CLOUD_APP_PR_TOOL_IDS.resolve,
  get_cloud_app_change_review: CLOUD_APP_PR_TOOL_IDS.review,
  read_cloud_app_change_file: CLOUD_APP_PR_TOOL_IDS.readFile,
};

export function resolveCloudAppPrToolAlias(toolId: string): string {
  return CLOUD_APP_PR_TOOL_LEGACY_ALIASES[toolId] ?? toolId;
}

export const CLOUD_APP_PR_OWNER_WORKFLOW = {
  summary:
    "Incoming contributor PRs on your published app (owner). Do not use inspect_cloud_repo or local edit_file to review proposals.",
  startWith: CLOUD_APP_PR_TOOL_IDS.check,
  tools: [
    CLOUD_APP_PR_TOOL_IDS.check,
    CLOUD_APP_PR_TOOL_IDS.list,
    CLOUD_APP_PR_TOOL_IDS.review,
    CLOUD_APP_PR_TOOL_IDS.readFile,
    CLOUD_APP_PR_TOOL_IDS.resolve,
  ],
  steps: [
    `check_cloud_app_contributions({ appId }) or list_cloud_app_prs({ appId })`,
    `get_cloud_app_pr_review({ requestId }) for unified diff (Papr per-app GitHub read token)`,
    `read_cloud_app_pr_file({ requestId, relativePath }) if patch is truncated`,
    `resolve_cloud_app_pr({ requestId, action: "approve"|"reject" })`,
  ],
} as const;

export const CLOUD_APP_PR_DEFERRED_FIND_QUERY =
  "cloud app contribution PR review owner approve reject";
