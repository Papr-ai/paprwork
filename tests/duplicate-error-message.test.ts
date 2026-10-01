import { describe, expect, it } from "vitest";
import { describeDuplicateError } from "../ui/utils/cloudTrackSyncApi";

describe("describeDuplicateError", () => {
  it("explains a publisher that has not allowed copies", () => {
    const msg = describeDuplicateError(
      'Cloud install prepare failed (403): {"detail":"Code install is not enabled for this app or you lack permission"}',
    );
    expect(msg).toMatch(/hasn't allowed copies/);
  });
  it("explains a network failure", () => {
    expect(describeDuplicateError("fetch failed")).toMatch(/Couldn't reach Papr Cloud/);
  });
  it("falls back to the raw reason", () => {
    expect(describeDuplicateError("boom")).toBe("Couldn't duplicate: boom");
  });
});
