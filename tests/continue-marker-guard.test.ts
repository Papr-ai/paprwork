import { describe, expect, it } from "vitest";
import {
  HIDDEN_CONTINUE_USER_MESSAGE,
  canSendContinueMarker,
} from "../ui/lib/agentStreamRecovery";

const msg = (role: "user" | "assistant", content: string) =>
  ({ id: `${role}-${content.length}`, role, content }) as never;

describe("canSendContinueMarker", () => {
  it("refuses on a fresh chat with no messages", () => {
    expect(canSendContinueMarker([])).toBe(false);
  });

  it("refuses when the only user message is itself a continue marker", () => {
    expect(
      canSendContinueMarker([msg("user", HIDDEN_CONTINUE_USER_MESSAGE)]),
    ).toBe(false);
  });

  it("allows when a visible user message exists", () => {
    expect(
      canSendContinueMarker([msg("user", "help me publish"), msg("assistant", "")]),
    ).toBe(true);
  });
});
