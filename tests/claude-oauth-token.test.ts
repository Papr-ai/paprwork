import { describe, expect, it } from "vitest";
import {
  cleanClaudeOAuthToken,
  isValidClaudeOAuthToken,
  previewClaudeOAuthToken,
} from "../ui/utils/claudeOAuthToken";

const SAMPLE_TOKEN =
  "sk-ant-oat01-" + "a".repeat(80);

describe("cleanClaudeOAuthToken", () => {
  it("removes spaces and line breaks", () => {
    const spaced = `${SAMPLE_TOKEN.slice(0, 20)} ${SAMPLE_TOKEN.slice(20, 40)}\n${SAMPLE_TOKEN.slice(40)}`;
    expect(cleanClaudeOAuthToken(spaced)).toBe(SAMPLE_TOKEN);
  });

  it("strips ANSI escape codes", () => {
    const withAnsi = `\x1b[32m${SAMPLE_TOKEN}\x1b[0m`;
    expect(cleanClaudeOAuthToken(withAnsi)).toBe(SAMPLE_TOKEN);
  });
});

describe("isValidClaudeOAuthToken", () => {
  it("accepts sk-ant-oat tokens with sufficient length", () => {
    expect(isValidClaudeOAuthToken(SAMPLE_TOKEN)).toBe(true);
  });

  it("rejects too-short tokens", () => {
    expect(isValidClaudeOAuthToken("sk-ant-oat01-short")).toBe(false);
  });
});

describe("previewClaudeOAuthToken", () => {
  it("truncates long tokens for display", () => {
    const preview = previewClaudeOAuthToken(SAMPLE_TOKEN);
    expect(preview).toContain("…");
    expect(preview.startsWith("sk-ant-oat01-")).toBe(true);
  });
});
