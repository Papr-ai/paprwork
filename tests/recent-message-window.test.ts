import { describe, expect, it } from "vitest";
import {
  computeRecentMessageLimit,
  expandRecentMessageLimit,
  RECENT_MESSAGES_MAX,
  RECENT_MESSAGES_MIN,
  resolveSummaryBaseMessageCount,
} from "../src/gateway/services/storage/recentMessageWindow.js";

describe("computeRecentMessageLimit", () => {
  it("starts at MIN when summary was just saved", () => {
    expect(computeRecentMessageLimit(80, 80)).toBe(RECENT_MESSAGES_MIN);
  });

  it("grows by one per new message up to MAX", () => {
    expect(computeRecentMessageLimit(81, 80)).toBe(21);
    expect(computeRecentMessageLimit(90, 80)).toBe(30);
    expect(computeRecentMessageLimit(100, 80)).toBe(RECENT_MESSAGES_MAX);
  });

  it("snaps back to MIN after 21 new messages then grows again", () => {
    expect(computeRecentMessageLimit(101, 80)).toBe(RECENT_MESSAGES_MIN);
    expect(computeRecentMessageLimit(102, 80)).toBe(21);
    expect(computeRecentMessageLimit(121, 80)).toBe(RECENT_MESSAGES_MAX);
    expect(computeRecentMessageLimit(122, 80)).toBe(RECENT_MESSAGES_MIN);
  });

  it("infers base from message count when summary base is missing", () => {
    // 100 messages, null base → inferred anchor at 80 → delta 20 → MAX window
    expect(computeRecentMessageLimit(100, null)).toBe(RECENT_MESSAGES_MAX);
    expect(computeRecentMessageLimit(10, null)).toBe(30);
  });
});

describe("resolveSummaryBaseMessageCount", () => {
  it("uses stored base when present", () => {
    expect(resolveSummaryBaseMessageCount(100, 80)).toBe(80);
  });

  it("falls back to message count minus MIN when base is null", () => {
    expect(resolveSummaryBaseMessageCount(100, null)).toBe(80);
    expect(resolveSummaryBaseMessageCount(5, null)).toBe(0);
  });
});

describe("expandRecentMessageLimit", () => {
  it("does not expand when oldest message is user", () => {
    expect(expandRecentMessageLimit(100, 20, "user")).toBe(20);
  });

  it("expands by one when window starts mid-turn on assistant", () => {
    expect(expandRecentMessageLimit(100, 20, "assistant")).toBe(21);
  });

  it("caps expansion at total message count", () => {
    expect(expandRecentMessageLimit(20, 20, "assistant")).toBe(20);
  });
});
