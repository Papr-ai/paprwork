import { describe, expect, it } from "vitest";
import { buildClaudeUsageTokenCandidates } from "../src/core/services/claudeUsageLimitCandidates.js";

describe("buildClaudeUsageTokenCandidates", () => {
  it("uses only Papr stored token when connected in-app", () => {
    expect(
      buildClaudeUsageTokenCandidates("papr-token", "cli-token"),
    ).toEqual([{ accessToken: "papr-token", source: "papr_stored" }]);
  });

  it("falls back to Claude Code storage when Papr has no token", () => {
    expect(buildClaudeUsageTokenCandidates(undefined, "cli-token")).toEqual([
      { accessToken: "cli-token", source: "claude_code_keychain" },
    ]);
  });

  it("returns empty when neither source is available", () => {
    expect(buildClaudeUsageTokenCandidates(null, null)).toEqual([]);
  });
});
