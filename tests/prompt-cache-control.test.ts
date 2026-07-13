import { describe, expect, test } from "vitest";
import {
  applyAnthropicPromptCacheControl,
  shouldEnableAnthropicPromptCache,
} from "../src/gateway/services/agent/promptCacheControl.js";

describe("promptCacheControl", () => {
  test("shouldEnableAnthropicPromptCache only for anthropic API key route", () => {
    expect(
      shouldEnableAnthropicPromptCache({
        provider: "anthropic",
        authType: "apiKey",
      }),
    ).toBe(true);
    expect(
      shouldEnableAnthropicPromptCache({
        provider: "anthropic",
        authType: "oauth",
      }),
    ).toBe(false);
    expect(
      shouldEnableAnthropicPromptCache({
        provider: "openai",
        authType: "apiKey",
      }),
    ).toBe(false);
  });

  test("applyAnthropicPromptCacheControl adds breakpoints to system and last message", () => {
    const longSystem = "x".repeat(20_000);
    const messages = applyAnthropicPromptCacheControl(
      [
        { role: "system", content: longSystem },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "follow up" },
      ],
      { provider: "anthropic", authType: "apiKey" },
    );

    expect(messages[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
    expect(messages[messages.length - 1].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
    });
  });

  test("skips cache for oauth anthropic route", () => {
    const messages = applyAnthropicPromptCacheControl(
      [{ role: "user", content: "hello" }],
      { provider: "anthropic", authType: "oauth" },
    );
    expect(messages[0].providerOptions).toBeUndefined();
  });
});
