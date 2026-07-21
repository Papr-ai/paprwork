import { describe, expect, it } from "vitest";
import {
  computeContentHash,
  computeDedupKey,
  evaluateBashCapture,
  extractUsedListedKeys,
  isAuthOnlyResult,
} from "../src/gateway/services/toolCapture/evaluation.js";

describe("tool capture evaluation", () => {
  it("extracts only listed keys referenced in the command", () => {
    const keys = extractUsedListedKeys(
      "curl https://zoom.us/oauth/token -d account_id=${ZOOM_ACCOUNT_ID}",
      ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_SECRET", "NEON_DB_URL"],
    );
    expect(keys).toEqual(["ZOOM_ACCOUNT_ID"]);
  });

  it("skips excluded PAPR_API_KEY even when listed", () => {
    const keys = extractUsedListedKeys(
      "curl ${PAPR_API_KEY}",
      ["PAPR_API_KEY", "ZOOM_ACCOUNT_ID"],
    );
    expect(keys).toEqual([]);
  });

  it("rejects auth-only token responses", () => {
    const tokenJson = JSON.stringify({
      access_token: "abc123",
      token_type: "bearer",
      expires_in: 3600,
    });
    expect(isAuthOnlyResult(tokenJson)).toBe(true);
    expect(
      evaluateBashCapture({
        originalCommand: "curl ${ZOOM_ACCOUNT_ID}",
        stdout: tokenJson,
        listedKeyNames: ["ZOOM_ACCOUNT_ID"],
      }),
    ).toBeNull();
  });

  it("accepts substantive bash output that uses registered keys", () => {
    const transcript = "Meeting: Papr Daily\n2026-06-24\n" + "x".repeat(1200);
    const evaluation = evaluateBashCapture({
      originalCommand:
        "curl https://zoom.us/v2/meetings/${MEETING_ID}/recordings",
      stdout: transcript,
      listedKeyNames: ["MEETING_ID", "ZOOM_ACCOUNT_ID"],
    });

    expect(evaluation).not.toBeNull();
    expect(evaluation?.keysUsed).toEqual(["MEETING_ID"]);
    expect(evaluation?.inferredLabel).toBe("meeting");
    expect(evaluation?.contentDate).toBe("2026-06-24");
  });

  it("dedup key is stable for same semantic identity", () => {
    const a = computeDedupKey({
      inferredLabel: "zoom",
      contentDate: "2026-06-24",
      stableEntityId: "12345",
    });
    const b = computeDedupKey({
      inferredLabel: "zoom",
      contentDate: "2026-06-24",
      stableEntityId: "12345",
    });
    expect(a).toBe(b);
  });

  it("content hash changes when body changes", () => {
    const a = computeContentHash("hello world");
    const b = computeContentHash("hello world!");
    expect(a).not.toBe(b);
  });
});
