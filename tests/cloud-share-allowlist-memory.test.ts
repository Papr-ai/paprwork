import { describe, expect, it } from "vitest";
import {
  memoryShareAllowlistBodyFromPrefs,
  prefsPeopleAllowlistChanged,
} from "../src/gateway/services/cloudShareAllowlistMemory.js";

describe("cloudShareAllowlistMemory", () => {
  it("normalizes allowlist fields for Memory publish body", () => {
    expect(
      memoryShareAllowlistBodyFromPrefs({
        allowedUserIds: [" b ", "b"],
        allowedEmails: ["A@Example.com"],
        allowedEmailDomains: ["@Client.com"],
      }),
    ).toEqual({
      allowedUserIds: ["b"],
      allowedEmails: ["a@example.com"],
      allowedEmailDomains: ["client.com"],
    });
  });

  it("detects allowlist-only prefs updates", () => {
    expect(prefsPeopleAllowlistChanged({})).toBe(false);
    expect(prefsPeopleAllowlistChanged({ allowedEmails: ["a@b.com"] })).toBe(
      true,
    );
  });
});
