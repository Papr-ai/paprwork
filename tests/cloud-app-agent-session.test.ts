import { describe, expect, it } from "vitest";
import {
  isCloudAppAgentWarmSession,
  resolveCloudAgentChatId,
  resolveCloudAppAgentUserMessage,
  resolveCloudUserDataPath,
} from "../src/gateway/services/cloudAgentGateway/cloudAppAgentSession.js";
import { isWorkspaceChatJob } from "../src/core/constants/workspaceChatJob.js";
import type { CloudAgentRunRequest } from "../src/gateway/services/cloudAgentGateway/types.js";

function baseRequest(
  overrides: Partial<CloudAgentRunRequest> = {},
): CloudAgentRunRequest {
  return {
    orgId: "org-1",
    userId: "user-1",
    jobId: "job-1",
    runId: "run-abc",
    paprApiKey: "sk-test",
    repoCloneUrl: "https://example.com/repo.git",
    repoToken: "token",
    llmAuth: { provider: "openai", token: "key", authType: "apiKey" },
    ...overrides,
  };
}

describe("cloudAppAgentSession helpers", () => {
  it("detects warm app-agent sessions", () => {
    expect(
      isCloudAppAgentWarmSession(
        baseRequest({ workspaceSessionId: "sess-1", keepWorkspaceWarm: true }),
      ),
    ).toBe(true);
    expect(
      isCloudAppAgentWarmSession(
        baseRequest({ workspaceSessionId: "sess-1", keepWorkspaceWarm: false }),
      ),
    ).toBe(false);
    expect(isCloudAppAgentWarmSession(baseRequest())).toBe(false);
  });

  it("uses stable app-agent chat id for warm sessions", () => {
    expect(
      resolveCloudAgentChatId(
        baseRequest({
          workspaceSessionId: "sess-uuid",
          keepWorkspaceWarm: true,
          jobId: "job-x",
          runId: "run-y",
        }),
      ),
    ).toBe("app-agent:sess-uuid");
  });

  it("uses stable workspace-chat id for Papr Web warm sessions", () => {
    expect(isWorkspaceChatJob("workspace-chat")).toBe(true);
    expect(
      resolveCloudAgentChatId(
        baseRequest({
          workspaceSessionId: "web-chat-1",
          keepWorkspaceWarm: true,
          jobId: "workspace-chat",
          runId: "run-y",
        }),
      ),
    ).toBe("workspace-chat:web-chat-1");
  });

  it("uses per-run job chat id for one-shot cloud jobs", () => {
    expect(
      resolveCloudAgentChatId(
        baseRequest({ jobId: "job-x", runId: "run-y" }),
      ),
    ).toBe("job:job-x:run-y");
  });

  it("places user data under the sandbox run root", () => {
    expect(resolveCloudUserDataPath("/tmp/papr-cloud-session/s1")).toBe(
      "/tmp/papr-cloud-session/s1/user-data",
    );
  });

  it("reads user message from runtimeParams.prompt", () => {
    expect(
      resolveCloudAppAgentUserMessage(
        baseRequest({
          runtimeParams: { prompt: "  Hello there  " },
        }),
      ),
    ).toBe("Hello there");
  });

  it("throws when app-agent turn has no user message", () => {
    expect(() => resolveCloudAppAgentUserMessage(baseRequest())).toThrow(
      /runtimeParams\.prompt/,
    );
  });
});
