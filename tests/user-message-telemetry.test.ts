import { describe, expect, it } from "vitest";
import { userMessageSentProperties } from "../src/gateway/services/userMessageTelemetry.js";

const base = {
  chatId: "chat-1",
  model: "claude-sonnet-5-5",
  provider: "anthropic",
  usesPaprProxy: false,
};

describe("userMessageSentProperties", () => {
  it("builds properties for a visible user-authored message", () => {
    expect(
      userMessageSentProperties({ ...base, userMessage: "Hello" }),
    ).toEqual({
      chat_id: "chat-1",
      message_length: 5,
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      auth_type: "apiKey",
      uses_papr_proxy: false,
    });
  });

  it("excludes synthetic hidden continuation turns", () => {
    expect(
      userMessageSentProperties({
        ...base,
        userMessage: "[__papr_continue__] Continue your previous response.",
      }),
    ).toBeNull();
  });
});
