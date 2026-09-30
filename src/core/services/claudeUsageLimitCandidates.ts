import type { ClaudeUsageLimitsSnapshot } from "./claudeOAuthUsage.js";

export type ClaudeUsageTokenCandidate = {
  accessToken: string;
  source: NonNullable<ClaudeUsageLimitsSnapshot["credentialSource"]>;
};

/**
 * Usage polling should use Papr's stored OAuth token when present. Probing
 * Claude Code Keychain / ~/.claude only applies when the user has not connected
 * in Paprwork yet (or has no stored token).
 */
export function buildClaudeUsageTokenCandidates(
  paprAccessToken: string | undefined | null,
  cliAccessToken: string | undefined | null,
): ClaudeUsageTokenCandidate[] {
  if (paprAccessToken) {
    return [{ accessToken: paprAccessToken, source: "papr_stored" }];
  }
  if (cliAccessToken) {
    return [{ accessToken: cliAccessToken, source: "claude_code_keychain" }];
  }
  return [];
}
