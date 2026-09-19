import { describe, expect, it, vi } from "vitest";
import {
  buildCloudAgentRunDedupKey,
  resetCloudAgentRunDedupForTests,
  runWithCloudAgentRunDedup,
} from "../src/gateway/services/cloudAgentGateway/cloudAgentRunDedup.js";
import {
  deriveScheduledCloudRunId,
  resolveCloudAgentRunId,
} from "../src/gateway/services/cloudAgentGateway/cloudAgentRunId.js";
import type { CloudAgentRunRequest } from "../src/gateway/services/cloudAgentGateway/types.js";

function sampleRequest(
  overrides: Partial<CloudAgentRunRequest> = {},
): CloudAgentRunRequest {
  return {
    orgId: "org-1",
    namespaceId: "ns-1",
    userId: "user-1",
    jobId: "1e57a7da-fe6a-4c1e-87c3-53887b1f2230",
    runId: "a1c113a7d73d",
    paprApiKey: "sk-test",
    repoCloneUrl: "https://example.com/repo.git",
    repoToken: "token",
    llmAuth: { provider: "anthropic", token: "key", authType: "oauth" },
    ...overrides,
  };
}

describe("cloudAgentRunId", () => {
  it("prefers explicit runId from scheduler lease", () => {
    expect(
      resolveCloudAgentRunId({
        jobId: "job-1",
        runId: "22-92df4e44",
        scheduledDueAt: "2026-09-15T19:22:36.000Z",
      }),
    ).toBe("22-92df4e44");
  });

  it("derives stable runId from jobId + scheduledDueAt when runId omitted", () => {
    const dueAt = "2026-09-15T19:22:36.000Z";
    const jobId = "1e57a7da-fe6a-4c1e-87c3-53887b1f2230";
    const a = resolveCloudAgentRunId({ jobId, scheduledDueAt: dueAt });
    const b = deriveScheduledCloudRunId(jobId, dueAt);
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });
});

describe("cloudAgentRunDedup", () => {
  it("builds sched key from scheduledDueAt", () => {
    const key = buildCloudAgentRunDedupKey(
      sampleRequest({ scheduledDueAt: "2026-09-15T19:22:36.000Z" }),
    );
    expect(key).toContain("sched:");
    expect(key).toContain("2026-09-15T19:22:36.000Z");
  });

  it("skips dedup for warm app-agent sessions", () => {
    expect(
      buildCloudAgentRunDedupKey(
        sampleRequest({
          workspaceSessionId: "sess-1",
          keepWorkspaceWarm: true,
          scheduledDueAt: "2026-09-15T19:22:36.000Z",
        }),
      ),
    ).toBeNull();
  });

  it("coalesces parallel runAgentJob calls for the same scheduled slot", async () => {
    resetCloudAgentRunDedupForTests();
    const execute = vi.fn(async () => ({
      exitCode: 0,
      output: "ok",
      chatId: "job:x:abc",
    }));

    const request = sampleRequest({
      scheduledDueAt: "2026-09-15T19:22:36.000Z",
    });

    const [a, b] = await Promise.all([
      runWithCloudAgentRunDedup(request, execute),
      runWithCloudAgentRunDedup(request, execute),
    ]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("returns cached success without re-executing", async () => {
    resetCloudAgentRunDedupForTests();
    let calls = 0;
    const request = sampleRequest({
      scheduledDueAt: "2026-09-15T19:22:36.000Z",
      runId: "22-92df4e44",
    });

    await runWithCloudAgentRunDedup(request, async () => {
      calls += 1;
      return { exitCode: 0, output: "done", chatId: "job:x:22-92df4e44" };
    });

    await runWithCloudAgentRunDedup(request, async () => {
      calls += 1;
      return { exitCode: 0, output: "should-not-run", chatId: "nope" };
    });

    expect(calls).toBe(1);
  });
});
