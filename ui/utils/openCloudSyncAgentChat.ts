/** Open main chat with context for cloud git merge / PR review (desktop only). */
export function openCloudSyncAgentChat(message: string): void {
  window.dispatchEvent(
    new CustomEvent("papr-chat-open", {
      detail: { message },
    }),
  );
}

export function buildMergeReviewAgentPrompt(input: {
  appId?: string;
  headline?: string | null;
  error?: string | null;
}): string {
  const parts = [
    "Help me as the app owner review and merge cloud git changes into my Papr workspace.",
  ];
  if (input.appId) {
    parts.push(`App id: ${input.appId}.`);
  }
  if (input.headline?.trim()) {
    parts.push(`Remote summary: ${input.headline.trim()}.`);
  }
  if (input.error?.trim()) {
    parts.push(`Last merge error: ${input.error.trim()}.`);
  }
  parts.push(
    "Use inspect_cloud_repo and get_cloud_sync_status. Summarize what changed, whether I should merge or reject, and resolve conflicts safely if needed.",
  );
  return parts.join(" ");
}

export function buildSchemaDriftAgentPrompt(input: {
  appId?: string;
  databases?: ReadonlyArray<{ alias: string; detail?: string }>;
  publishDetail?: string | null;
  error?: string | null;
}): string {
  const parts = [
    "Help me fix a Turso database schema drift that is blocking Web sync / Upload for my Papr mini-app.",
    "Upload completes but the Web sync panel still shows schema drift — local SQLite schema does not match Turso.",
  ];
  if (input.appId) {
    parts.push(`App id: ${input.appId}.`);
  }
  if (input.databases?.length) {
    const dbLines = input.databases
      .map((db) => `${db.alias}${db.detail ? `: ${db.detail}` : ""}`)
      .join("; ");
    parts.push(`Linked databases: ${dbLines}.`);
  }
  if (input.publishDetail?.trim()) {
    parts.push(`Publish blocker: ${input.publishDetail.trim()}.`);
  }
  if (input.error?.trim()) {
    parts.push(`Last upload error: ${input.error.trim()}.`);
  }
  parts.push(
    "Workflow: get_cloud_sync_status → compare local vs Turso schema for the linked database → run schema drift heal / ship missing migrations → verify web-ready → Upload now if needed.",
    "If the local data.db is corrupt (NOTADB or all zeros), restore from the newest .sync-backup file in the same folder before syncing.",
  );
  return parts.join(" ");
}

export function buildWriterConflictAgentPrompt(input: {
  appId?: string;
  error?: string | null;
}): string {
  const parts = [
    "Help me resolve a cloud repo upload conflict (writer 409) for my Papr mini-app.",
    "The cloud copy changed since my last upload, so my push was rejected.",
  ];
  if (input.appId) {
    parts.push(`App id: ${input.appId}.`);
  }
  if (input.error?.trim()) {
    parts.push(`Last error: ${input.error.trim()}.`);
  }
  parts.push(
    "Workflow: get_cloud_sync_status → inspect_cloud_repo (see what changed on the web) → merge remote changes OR edit my local files to incorporate remote updates → push_cloud_sync / Upload now.",
    "Do not blindly overwrite — explain what changed and what I should keep before uploading again.",
  );
  return parts.join(" ");
}

export function buildPrReviewAgentPrompt(input: {
  sourceAppId: string;
  title: string;
  description: string;
  prUrl?: string | null;
}): string {
  const parts = [
    `Help me review an incoming contribute-back proposal for my app (${input.sourceAppId}).`,
    `Title: ${input.title}.`,
    `Description: ${input.description}.`,
  ];
  if (input.prUrl) {
    parts.push(`GitHub PR: ${input.prUrl}.`);
  }
  parts.push(
    "Use list_cloud_app_changes and inspect_cloud_repo. Explain the code diff, risks, and whether I should Accept or Decline. If I accept, guide me through merge + local sync.",
  );
  return parts.join(" ");
}
