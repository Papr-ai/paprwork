import { describe, expect, it } from "vitest";
import {
  flushQueueAppsAhead,
  formatFlushQueueDetail,
  formatFlushQueueLabel,
} from "../src/gateway/services/cloudSync/flushQueueCopy.js";

describe("flushQueueCopy", () => {
  it("computes apps ahead from queue position", () => {
    expect(flushQueueAppsAhead(1)).toBe(0);
    expect(flushQueueAppsAhead(5)).toBe(4);
  });

  it("formats queue label with apps ahead", () => {
    expect(formatFlushQueueLabel(5, 12)).toBe("4 apps ahead · 12 in queue");
    expect(formatFlushQueueLabel(1, 12)).toBe("Next in upload queue");
  });

  it("formats queue detail with bump hint", () => {
    expect(formatFlushQueueDetail(5, 12)).toContain("4 other apps uploading first");
    expect(formatFlushQueueDetail(5, 12)).toContain("Upload now");
    expect(formatFlushQueueDetail(1, 3)).toBe(
      "Next in line — upload starting soon.",
    );
  });
});
