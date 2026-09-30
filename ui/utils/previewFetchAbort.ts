/** Abort messages from papr-preview-fetch-gate — not real app failures. */
const PREVIEW_FETCH_ABORT_PATTERNS: readonly RegExp[] = [
  /Preview became visible — stale background fetches aborted/,
  /^Preview evicted$/,
];

function innerPreviewAbortMessage(message: string): string {
  const trimmed = message.trim();
  const prefix = "Unhandled rejection:";
  if (trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

/** True when an iframe runtime log is a preview tab lifecycle fetch abort. */
export function isBenignPreviewFetchAbortMessage(message: string): boolean {
  const inner = innerPreviewAbortMessage(message);
  return PREVIEW_FETCH_ABORT_PATTERNS.some((pattern) => pattern.test(inner));
}
