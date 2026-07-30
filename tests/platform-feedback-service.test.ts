import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gateway/utils/cloudApiClient.js", () => ({
  cloudApiFetch: vi.fn(),
}));

vi.mock("../src/gateway/utils/keyResolver.js", () => ({
  getPaprApiKey: vi.fn(),
}));

import { cloudApiFetch } from "../src/gateway/utils/cloudApiClient.js";
import { getPaprApiKey } from "../src/gateway/utils/keyResolver.js";
import {
  buildPlatformIssueBody,
  canSubmitPlatformIssue,
  PLATFORM_FEEDBACK_ISSUES_PATH,
  submitPlatformIssue,
} from "../src/gateway/services/PlatformFeedbackService.js";

const cloudApiFetchMock = vi.mocked(cloudApiFetch);
const getPaprApiKeyMock = vi.mocked(getPaprApiKey);

describe("PlatformFeedbackService", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("buildPlatformIssueBody includes user content and environment metadata", () => {
    process.env.PAPRWORK_APP_VERSION = "2.0.48";
    process.env.PAPRWORK_IS_PACKAGED = "true";
    process.env.PAPRWORK_TELEMETRY_ANONYMOUS_ID = "install-abc";

    const body = buildPlatformIssueBody({
      type: "bug",
      title: "Test",
      body: "Steps:\n1. Open chat\n2. Crash",
      contactEmail: "user@example.com",
    });

    expect(body).toContain("Steps:");
    expect(body).toContain("2.0.48");
    expect(body).toContain("install-abc");
    expect(body).toContain("user@example.com");
    expect(body).toContain("Submitted via Papr Work");
  });

  it("canSubmitPlatformIssue is true when Papr API key is available", async () => {
    delete process.env.PAPR_GITHUB_ISSUE_TOKEN;
    getPaprApiKeyMock.mockResolvedValue("sk-test");

    await expect(canSubmitPlatformIssue()).resolves.toBe(true);
  });

  it("canSubmitPlatformIssue is true with dev GitHub token only", async () => {
    getPaprApiKeyMock.mockResolvedValue(undefined);
    process.env.PAPR_GITHUB_ISSUE_TOKEN = "ghp_test";

    await expect(canSubmitPlatformIssue()).resolves.toBe(true);
  });

  it("submitPlatformIssue posts to memory server when Papr key is set", async () => {
    getPaprApiKeyMock.mockResolvedValue("sk-test");
    cloudApiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          issueNumber: 99,
          issueUrl: "https://github.com/Papr-ai/paprwork/issues/99",
          title: "Bug: Memory path",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await submitPlatformIssue({
      type: "bug",
      title: "Bug: Memory path",
      body: "Something broke.",
    });

    expect(result.issueNumber).toBe(99);
    expect(result.via).toBe("memory-server");
    expect(cloudApiFetchMock).toHaveBeenCalledWith(
      PLATFORM_FEEDBACK_ISSUES_PATH,
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          type: "bug",
          title: "Bug: Memory path",
          body: "Something broke.",
          environment: expect.objectContaining({
            platform: process.platform,
          }),
        }),
      }),
    );
  });

  it("submitPlatformIssue falls back to dev GitHub token when memory server fails", async () => {
    getPaprApiKeyMock.mockResolvedValue("sk-test");
    process.env.PAPR_GITHUB_ISSUE_TOKEN = "ghp_test";

    cloudApiFetchMock.mockResolvedValue(
      new Response("not found", { status: 404 }),
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        number: 42,
        html_url: "https://github.com/Papr-ai/paprwork/issues/42",
        title: "Bug: Example",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitPlatformIssue({
      type: "bug",
      title: "Bug: Example",
      body: "Something broke.",
    });

    expect(result.issueNumber).toBe(42);
    expect(result.via).toBe("dev-github-token");
  });

  it("submitPlatformIssue throws when neither Papr key nor dev token is available", async () => {
    getPaprApiKeyMock.mockResolvedValue(undefined);
    delete process.env.PAPR_GITHUB_ISSUE_TOKEN;

    await expect(
      submitPlatformIssue({
        type: "feature",
        title: "Feature: Dark mode",
        body: "Would like a toggle.",
      }),
    ).rejects.toThrow(/Log in with Papr|not available/i);
  });
});
