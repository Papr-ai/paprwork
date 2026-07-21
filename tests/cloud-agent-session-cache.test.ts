/**
 * Cloud agent gateway warm session cache tests.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudAgentRunRequest } from "../src/gateway/services/cloudAgentGateway/types.js";

vi.mock("../src/gateway/services/cloudAgentGateway/cloudAgentRunContext.js", () => ({
  beginCloudAgentRun: vi.fn(async () => ({
    runRoot: "/tmp/papr-cloud-session/test-session",
    paprHome: "/tmp/papr-cloud-session/test-session/Papr",
    tursoTargets: [],
    finish: vi.fn(async () => undefined),
  })),
  resolveCloudRunRoot: (request: CloudAgentRunRequest) =>
    `/tmp/papr-cloud-session/${request.workspaceSessionId ?? request.runId}`,
}));

import {
  CloudAgentSessionCache,
  resetCloudAgentSessionCacheForTests,
} from "../src/gateway/services/cloudAgentGateway/cloudAgentSessionCache.js";
import { beginCloudAgentRun } from "../src/gateway/services/cloudAgentGateway/cloudAgentRunContext.js";

function sampleRequest(sessionId: string): CloudAgentRunRequest {
  return {
    orgId: "org-1",
    userId: "user-1",
    jobId: "job-1",
    runId: sessionId,
    prompt: "hello",
    paprApiKey: "sk-test",
    repoCloneUrl: "https://example.com/repo.git",
    repoToken: "token",
    workspaceSessionId: sessionId,
    keepWorkspaceWarm: true,
    llmAuth: {
      provider: "openai",
      authType: "apiKey",
      token: "key",
    },
  };
}

describe("CloudAgentSessionCache", () => {
  afterEach(() => {
    resetCloudAgentSessionCacheForTests();
    vi.clearAllMocks();
  });

  it("dedupes concurrent beginSession calls", async () => {
    const cache = new CloudAgentSessionCache();
    const request = sampleRequest("session-dedupe");

    const [first, second] = await Promise.all([
      cache.beginSession(request),
      cache.beginSession(request),
    ]);

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(vi.mocked(beginCloudAgentRun)).toHaveBeenCalledTimes(1);
  });

  it("returns ready without recloning within TTL", async () => {
    const cache = new CloudAgentSessionCache();
    const request = sampleRequest("session-hit");

    await cache.beginSession(request);
    vi.mocked(beginCloudAgentRun).mockClear();

    const second = await cache.beginSession(request);
    expect(second.status).toBe("ready");
    expect(vi.mocked(beginCloudAgentRun)).not.toHaveBeenCalled();
  });

  it("serializes turn locks for the same session", async () => {
    const cache = new CloudAgentSessionCache();
    const order: string[] = [];

    const releaseA = await cache.acquireTurnLock("session-lock");
    order.push("a-acquired");

    const lockBPromise = cache.acquireTurnLock("session-lock").then((releaseB) => {
      order.push("b-acquired");
      releaseB();
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["a-acquired"]);

    releaseA();
    await lockBPromise;
    expect(order).toEqual(["a-acquired", "b-acquired"]);
  });

  it("evicts incompatible session when user changes", async () => {
    const cache = new CloudAgentSessionCache();
    await cache.beginSession(sampleRequest("session-user"));

    const otherUser = {
      ...sampleRequest("session-user"),
      userId: "user-2",
    };
    await cache.beginSession(otherUser);

    expect(vi.mocked(beginCloudAgentRun)).toHaveBeenCalledTimes(2);
  });
});

describe("resolveCloudRunRoot", () => {
  it("uses session directory for warm workspaces", async () => {
    const { resolveCloudRunRoot } = await import(
      "../src/gateway/services/cloudAgentGateway/cloudAgentRunContext.js"
    );
    const root = resolveCloudRunRoot({
      ...sampleRequest("abc"),
      workspaceSessionId: "abc",
      runId: "turn-1",
    });
    expect(root).toContain("papr-cloud-session");
    expect(root).toContain("abc");
  });
});
