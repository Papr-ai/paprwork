/**
 * Resolve Claude subscription usage the same way Claude Code does:
 * Bearer token from Claude Code's credential store + GET /api/oauth/usage.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type ClaudeAuthStatusSnapshot = {
  loggedIn: boolean;
  orgId: string | null;
  orgName: string | null;
  email: string | null;
  subscriptionType: string | null;
  authMethod: string | null;
};

export type ClaudeUsageCredentialSource =
  | "claude_code_keychain"
  | "papr_stored";

/** `claude auth status --json` — org id for web fallback, plan label for UI. */
export async function readClaudeAuthStatusFromCli(): Promise<ClaudeAuthStatusSnapshot | null> {
  try {
    const { stdout } = await execFileAsync(
      "claude",
      ["auth", "status", "--json"],
      {
        timeout: 12_000,
        env: process.env,
        maxBuffer: 256 * 1024,
      },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return {
      loggedIn: record.loggedIn === true,
      orgId: typeof record.orgId === "string" ? record.orgId : null,
      orgName: typeof record.orgName === "string" ? record.orgName : null,
      email: typeof record.email === "string" ? record.email : null,
      subscriptionType:
        typeof record.subscriptionType === "string"
          ? record.subscriptionType
          : null,
      authMethod:
        typeof record.authMethod === "string" ? record.authMethod : null,
    };
  } catch {
    return null;
  }
}

export function dedupeAccessTokens(
  candidates: { accessToken: string; source: ClaudeUsageCredentialSource }[],
): { accessToken: string; source: ClaudeUsageCredentialSource }[] {
  const seen = new Set<string>();
  const out: { accessToken: string; source: ClaudeUsageCredentialSource }[] = [];
  for (const item of candidates) {
    const trimmed = item.accessToken.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push({ accessToken: trimmed, source: item.source });
  }
  return out;
}
