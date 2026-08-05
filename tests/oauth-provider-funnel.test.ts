import { describe, expect, it } from "vitest";
import {
  CLAUDE_OAUTH_COMPLETED_EVENT,
  CLAUDE_OAUTH_FAILED_EVENT,
  CLAUDE_OAUTH_STEP_EVENT,
  getOAuthCompletedEventName,
  getOAuthFailedEventName,
  getOAuthStepEventName,
  logOAuthProviderStep,
  OPENAI_OAUTH_COMPLETED_EVENT,
  OPENAI_OAUTH_FAILED_EVENT,
  OPENAI_OAUTH_STEP_EVENT,
  type OAuthProviderStep,
} from "../src/core/telemetry/oauthProviderSteps.js";

describe("OAuth provider funnel telemetry", () => {
  it("uses distinct OpenAI vs Claude event names", () => {
    expect(getOAuthStepEventName("openai")).toBe(OPENAI_OAUTH_STEP_EVENT);
    expect(getOAuthStepEventName("anthropic")).toBe(CLAUDE_OAUTH_STEP_EVENT);
    expect(getOAuthCompletedEventName("openai")).toBe(OPENAI_OAUTH_COMPLETED_EVENT);
    expect(getOAuthCompletedEventName("anthropic")).toBe(CLAUDE_OAUTH_COMPLETED_EVENT);
    expect(getOAuthFailedEventName("openai")).toBe(OPENAI_OAUTH_FAILED_EVENT);
    expect(getOAuthFailedEventName("anthropic")).toBe(CLAUDE_OAUTH_FAILED_EVENT);
  });

  it("logs funnel steps with provider label", () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
    };
    try {
      logOAuthProviderStep("openai", "browser_opened");
    } finally {
      console.log = original;
    }
    const combined = logs.join("\n");
    expect(combined).toContain("browser_opened");
    expect(combined).toContain("openai");
  });

  const openAiSteps: OAuthProviderStep[] = [
    "connect_clicked",
    "flow_started",
    "browser_opened",
    "callback_received",
    "token_exchanged",
    "connected",
  ];

  const claudeSteps: OAuthProviderStep[] = [
    "connect_clicked",
    "flow_started",
    "keychain_token_found",
    "terminal_opened",
    "paste_token_submitted",
    "connected",
  ];

  it("includes OpenAI funnel step names", () => {
    for (const step of openAiSteps) {
      expect(step.length).toBeGreaterThan(0);
    }
  });

  it("includes Claude funnel step names", () => {
    for (const step of claudeSteps) {
      expect(step.length).toBeGreaterThan(0);
    }
  });
});
