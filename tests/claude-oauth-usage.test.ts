import { describe, expect, it } from "vitest";
import { parseClaudeUsagePayload } from "../src/core/services/claudeOAuthUsage.js";
import { dedupeAccessTokens } from "../src/core/services/claudeCodeUsageSource.js";

describe("parseClaudeUsagePayload", () => {
  it("parses limits array like claude.ai settings", () => {
    const snapshot = parseClaudeUsagePayload(
      {
        limits: [
          {
            kind: "session",
            group: "session",
            percent: 0,
            severity: "normal",
            is_active: false,
            resets_at: "2026-09-14T08:40:00.175727+00:00",
          },
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 17,
            severity: "normal",
            is_active: true,
            resets_at: "2026-09-15T07:00:00.175752+00:00",
          },
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 0,
            severity: "normal",
            is_active: false,
            resets_at: "2026-09-15T07:00:00+00:00",
            scope: { model: { display_name: "Fable" } },
          },
        ],
        extra_usage: { is_enabled: false },
      },
      "web",
    );

    expect(snapshot.source).toBe("web");
    expect(snapshot.rows).toHaveLength(3);
    expect(snapshot.rows[1]?.label).toBe("All models");
    expect(snapshot.rows[1]?.percent).toBe(17);
    expect(snapshot.rows[2]?.label).toBe("Fable");
    expect(snapshot.extraUsageEnabled).toBe(false);
  });

  it("falls back to five_hour and seven_day blocks", () => {
    const snapshot = parseClaudeUsagePayload(
      {
        five_hour: { utilization: 12.4, resets_at: "2026-09-14T08:40:00Z" },
        seven_day: { utilization: 17, resets_at: "2026-09-15T07:00:00Z" },
      },
      "oauth",
    );

    expect(snapshot.rows.map((r) => r.label)).toEqual([
      "Current session",
      "All models",
    ]);
    expect(snapshot.rows[0]?.percent).toBe(12);
    expect(snapshot.rows[1]?.percent).toBe(17);
  });
});

describe("dedupeAccessTokens", () => {
  it("keeps first source when tokens match", () => {
    const out = dedupeAccessTokens([
      { accessToken: "same", source: "claude_code_keychain" },
      { accessToken: "same", source: "papr_stored" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe("claude_code_keychain");
  });
});
