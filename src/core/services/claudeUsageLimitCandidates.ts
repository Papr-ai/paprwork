import type { ClaudeUsageLimitsSnapshot } from "./claudeOAuthUsage.js";

export type ClaudeUsageTokenCandidate = {
  accessToken: string;
  source: NonNullable<ClaudeUsageLimitsSnapshot["credentialSource"]>;
};

/**
 * Papr connects with `claude setup-token`, which is inference-only and cannot
 * read the plan-usage endpoint. Try Papr's token first, then fall back to a
 * full Claude Code login (`claude auth login`, Keychain / ~/.claude), which can.
 */
export function buildClaudeUsageTokenCandidates(
  paprAccessToken: string | undefined | null,
  cliAccessToken: string | undefined | null,
): ClaudeUsageTokenCandidate[] {
  const out: ClaudeUsageTokenCandidate[] = [];
  if (paprAccessToken) {
    out.push({ accessToken: paprAccessToken, source: "papr_stored" });
  }
  if (cliAccessToken) {
    out.push({ accessToken: cliAccessToken, source: "claude_code_keychain" });
  }
  return out;
}
