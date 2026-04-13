import { describe, it, expect } from "vitest";
import { isUserFacingChatId } from "../../utils/chatVisibility";

describe("isUserFacingChatId", () => {
  it("returns true for normal user chat ids", () => {
    expect(isUserFacingChatId("abc-123")).toBe(true);
    expect(isUserFacingChatId("chat-uuid")).toBe(true);
  });

  it("returns false for agent job session ids", () => {
    expect(
      isUserFacingChatId(
        "job:f98f409f-5efb-4813-9da5-36d10eadab6a:run-1",
      ),
    ).toBe(false);
  });

  it("returns false for delegation mini-chat ids", () => {
    expect(isUserFacingChatId("delegation:del-123")).toBe(false);
  });
});
