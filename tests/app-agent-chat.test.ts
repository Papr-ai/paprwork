/**
 * App Agent Chat — Phase 2 unit tests.
 */

import { describe, expect, it } from "vitest";
import {
  buildAppAgentChatContext,
  filterEmbeddedAppAgentToolIds,
  toPublicAppAgentChatConfig,
  type AppAgentChatConfig,
} from "../src/core/types/appAgentChat.js";
import { buildCloudTurnPrompt } from "../src/gateway/services/appAgentChat/appAgentChatPrompt.js";
import { mapGatewayStreamToAppAgentEvents } from "../src/gateway/services/appAgentChat/mapGatewayStreamToAppAgentEvents.js";
import { MemoryAppAgentChatSessionStore } from "../src/gateway/services/appAgentChat/AppAgentChatSessionStore.js";
import { AppAgentChatWarmCoordinator } from "../src/gateway/services/appAgentChat/AppAgentChatWarmCoordinator.js";

describe("filterEmbeddedAppAgentToolIds", () => {
  it("removes delegate_task and request_agent_input", () => {
    const filtered = filterEmbeddedAppAgentToolIds([
      "read_app_file",
      "delegate_task",
      "request_agent_input",
    ]);
    expect(filtered).toContain("read_app_file");
    expect(filtered).not.toContain("delegate_task");
    expect(filtered).not.toContain("request_agent_input");
  });
});

describe("buildCloudTurnPrompt", () => {
  it("includes user message and prior history", () => {
    const prompt = buildCloudTurnPrompt({
      history: [{ id: "1", role: "user", content: "Hi", timestamp: "" }],
      userMessage: "Update the dashboard",
    });
    expect(prompt).toContain("USER: Update the dashboard");
    expect(prompt).toContain("USER: Hi");
  });
});

describe("mapGatewayStreamToAppAgentEvents", () => {
  const turnId = "turn-1";

  it("maps gateway text-delta chunks", () => {
    const events = mapGatewayStreamToAppAgentEvents(
      { type: "text-delta", payload: { text: "Hello" } },
      turnId,
    );
    expect(events).toEqual([
      { type: "app-agent:text-delta", data: { turnId, text: "Hello" } },
    ]);
  });

  it("maps gateway reasoning-delta chunks", () => {
    const events = mapGatewayStreamToAppAgentEvents(
      { type: "reasoning-delta", payload: { text: "Let me check" } },
      turnId,
    );
    expect(events).toEqual([
      { type: "app-agent:thinking-delta", data: { turnId, text: "Let me check" } },
    ]);
  });

  it("maps gateway tool-call and tool-result", () => {
    const call = mapGatewayStreamToAppAgentEvents(
      {
        type: "tool-call",
        payload: { toolName: "read_app_file", toolCallId: "tc-1", args: { path: "index.html" } },
      },
      turnId,
    );
    expect(call[0]?.type).toBe("app-agent:tool-call");

    const result = mapGatewayStreamToAppAgentEvents(
      {
        type: "tool-result",
        payload: {
          toolName: "edit_app_file",
          toolCallId: "tc-1",
          result: { success: true },
          success: true,
        },
      },
      turnId,
    );
    expect(result[0]?.type).toBe("app-agent:tool-result");
  });

  it("passes through pre-mapped app-agent events", () => {
    const events = mapGatewayStreamToAppAgentEvents(
      { type: "app-agent:turn-done", data: { assistantText: "Done", shouldRefreshApp: true } },
      turnId,
    );
    expect(events[0]).toEqual({
      type: "app-agent:turn-done",
      data: { assistantText: "Done", shouldRefreshApp: true, turnId },
    });
  });
});

describe("MemoryAppAgentChatSessionStore", () => {
  it("creates and loads sessions", async () => {
    const store = new MemoryAppAgentChatSessionStore();
    const session = await store.createSession({
      appId: "app-1",
      subAgentId: "agent-1",
    });
    const loaded = await store.getSession(session.id);
    expect(loaded?.appId).toBe("app-1");
  });
});

describe("AppAgentChatWarmCoordinator", () => {
  it("dedupes concurrent warm calls", async () => {
    const coordinator = new AppAgentChatWarmCoordinator();
    let warmCalls = 0;

    const warm = () =>
      coordinator.ensureWarm("session-1", async () => {
        warmCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: "ready" as const };
      });

    const [a, b] = await Promise.all([warm(), warm()]);
    expect(a).toBe("ready");
    expect(b).toBe("ready");
    expect(warmCalls).toBe(1);
  });

  it("returns ready without re-warming within TTL", async () => {
    const coordinator = new AppAgentChatWarmCoordinator();
    await coordinator.ensureWarm("session-2", async () => ({ status: "ready" }));
    let warmCalls = 0;
    const status = await coordinator.ensureWarm("session-2", async () => {
      warmCalls += 1;
      return { status: "ready" as const };
    });
    expect(status).toBe("ready");
    expect(warmCalls).toBe(0);
  });

  it("marks desktop sessions ready instantly", () => {
    const coordinator = new AppAgentChatWarmCoordinator();
    coordinator.markReady("desktop-session");
    expect(coordinator.getStatus("desktop-session")).toBe("ready");
  });
});

describe("appAgentChat public config", () => {
  const sample: AppAgentChatConfig = {
    enabled: true,
    subAgentId: "assistant",
    cloudJobId: "job-secret",
    allowedToolIds: ["read_app_file"],
  };

  it("does not expose cloudJobId in public config", () => {
    const pub = toPublicAppAgentChatConfig(sample);
    expect(pub).not.toHaveProperty("cloudJobId");
  });

  it("builds generic app context", () => {
    const ctx = buildAppAgentChatContext("id", "My App", sample);
    expect(ctx).toContain("My App");
    expect(ctx).not.toContain("audit");
  });
});
