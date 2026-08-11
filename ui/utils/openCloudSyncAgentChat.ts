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
