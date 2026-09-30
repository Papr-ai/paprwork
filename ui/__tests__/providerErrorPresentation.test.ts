/**
 * The strings here are the ones users actually hit — copied from the gateway
 * rewrites in useAgent and from raw Anthropic/OpenAI bodies — because the only
 * failure that matters for this module is a real message landing in the wrong
 * bucket and telling someone to go fix the wrong thing.
 */

import { describe, expect, it } from "vitest";
import {
  connectionRecoveryNotice,
  describeProviderNotice,
} from "../utils/providerErrorPresentation";

describe("describeProviderNotice", () => {
  it("reads a spent Claude allowance as a limit, not a broken key", () => {
    const notice = describeProviderNotice({
      message:
        "Claude usage limit reached. Your limit resets at 3:00 PM. Retrying won't help.",
      provider: "anthropic",
    });

    expect(notice.kind).toBe("usage-limit");
    expect(notice.headline).toBe("Usage limit reached");
    // The reset time is the one planning fact in the paragraph, so it is
    // promoted into the sentence rather than left in the details.
    expect(notice.guidance).toContain("3:00 PM");
    expect(notice.guidance).toContain("Claude");
    expect(notice.action).toBe("settings");
  });

  it("never sends a spent allowance down the auth path", () => {
    // This was the original bug in words: a 429-ish limit rewritten as
    // "Invalid API key" sent people to re-create a key that could not help.
    const notice = describeProviderNotice({
      message: "usage limit reached (429). Retrying won't help.",
      provider: "anthropic",
    });
    expect(notice.kind).not.toBe("auth");
    expect(notice.kind).not.toBe("rate-limit");
  });

  it("keeps a refused key separate from a spent one", () => {
    const notice = describeProviderNotice({
      message: "OAuth access token is invalid.",
      provider: "anthropic",
    });
    expect(notice.kind).toBe("auth");
    expect(notice.tone).toBe("error");
    expect(notice.action).toBe("settings");
    expect(notice.guidance).toContain("Settings");
  });

  it("names credits as credits", () => {
    const notice = describeProviderNotice({
      message:
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.",
      provider: "anthropic",
    });
    expect(notice.kind).toBe("credits");
    expect(notice.headline).toBe("Out of credits");
  });

  it("offers Resume for a rate limit only when the turn can be retried", () => {
    const throttled = describeProviderNotice({
      message: "Rate limit exceeded (429)",
      provider: "openai",
      canResume: true,
    });
    expect(throttled.kind).toBe("rate-limit");
    expect(throttled.action).toBe("resume");
    expect(throttled.tone).toBe("warning");

    const noRetry = describeProviderNotice({
      message: "Rate limit exceeded (429)",
      provider: "openai",
    });
    expect(noRetry.action).toBe("none");
    expect(noRetry.guidance).toContain("switch models");
  });

  it("tells the user an overload is not their fault", () => {
    const notice = describeProviderNotice({
      message: "overloaded_error: Overloaded (529)",
      provider: "anthropic",
    });
    expect(notice.kind).toBe("provider-busy");
    expect(notice.headline).toBe("Claude is busy");
    expect(notice.guidance).toContain("nothing is wrong with your setup");
  });

  it("handles a 500 from any provider as a provider problem", () => {
    const notice = describeProviderNotice({
      message: "Internal Server Error (500)",
      provider: "google",
    });
    expect(notice.kind).toBe("provider-busy");
    expect(notice.headline).toBe("Gemini is busy");
  });

  it("distinguishes an empty stream from a dropped one", () => {
    expect(
      describeProviderNotice({ message: "No output generated" }).kind,
    ).toBe("empty-response");
    expect(
      describeProviderNotice({
        message: "stream disconnected before completion",
      }).kind,
    ).toBe("interrupted");
  });

  it("points an over-long chat at a new chat, with no button to press", () => {
    const notice = describeProviderNotice({
      message: "prompt is too long: 210000 tokens > 200000 maximum context",
    });
    expect(notice.kind).toBe("context-length");
    expect(notice.action).toBe("none");
  });

  it("keeps the provider's words verbatim for the details disclosure", () => {
    const raw = "Rate limit exceeded (429): retry after 12s";
    expect(describeProviderNotice({ message: raw }).detail).toBe(raw);
  });

  it("falls back without pretending to know the cause", () => {
    const notice = describeProviderNotice({
      message: "AI_TypeValidationError: invalid_union",
      modelName: "Claude Sonnet 4.6",
    });
    expect(notice.kind).toBe("unknown");
    expect(notice.guidance).toContain("Claude Sonnet 4.6");
  });

  it("writes a headline short enough to sit in the composer", () => {
    const messages = [
      "Claude usage limit reached, resets at 3:00 PM",
      "credit balance is too low",
      "OAuth access token is invalid.",
      "Rate limit exceeded (429)",
      "Overloaded (529)",
      "No output generated",
      "maximum context length exceeded",
      "stream aborted",
      "something unmapped",
    ];
    for (const message of messages) {
      const { headline } = describeProviderNotice({
        message,
        provider: "anthropic",
      });
      expect(headline.length).toBeLessThanOrEqual(24);
      expect(headline.split(" ").length).toBeLessThanOrEqual(4);
    }
  });
});

describe("connectionRecoveryNotice", () => {
  it("offers Resume and carries no provider text to disclose", () => {
    const notice = connectionRecoveryNotice();
    expect(notice.action).toBe("resume");
    expect(notice.detail).toBe("");
  });
});
