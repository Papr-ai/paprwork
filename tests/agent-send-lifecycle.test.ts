import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSendGenerationCurrent,
  nextSendGeneration,
  noSendSince,
  peekSendGeneration,
} from "../ui/utils/agentSendLifecycle.js";

const useAgentSource = readFileSync(
  join(__dirname, "../ui/hooks/useAgent.ts"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

function functionBody(name: string): string {
  const start = useAgentSource.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = useAgentSource.indexOf("\n  const ", start + 1);
  return useAgentSource.slice(start, end === -1 ? undefined : end);
}

describe("agentSendLifecycle", () => {
  it("bumps generation and marks prior send stale after preempt", () => {
    const gens = new Map<string, number>();
    const first = nextSendGeneration(gens, "chat-1");
    expect(isSendGenerationCurrent(gens, "chat-1", first)).toBe(true);

    const second = nextSendGeneration(gens, "chat-1");
    expect(isSendGenerationCurrent(gens, "chat-1", first)).toBe(false);
    expect(isSendGenerationCurrent(gens, "chat-1", second)).toBe(true);
  });

  it("noSendSince holds until a user send starts, including for chats with no prior send", () => {
    const gens = new Map<string, number>();
    const fresh = peekSendGeneration(gens, "chat-1");
    expect(noSendSince(gens, "chat-1", fresh)).toBe(true);

    nextSendGeneration(gens, "chat-1");
    expect(noSendSince(gens, "chat-1", fresh)).toBe(false);

    const later = peekSendGeneration(gens, "chat-1");
    expect(noSendSince(gens, "chat-1", later)).toBe(true);
    nextSendGeneration(gens, "chat-2");
    expect(noSendSince(gens, "chat-1", later)).toBe(true);
  });

  it("replays the new-chat incident: a user send between the auto-continue decision and the hidden continue wins", () => {
    const gens = new Map<string, number>();
    nextSendGeneration(gens, "chat-1");
    const autoContinueSnapshot = peekSendGeneration(gens, "chat-1");
    nextSendGeneration(gens, "chat-1");
    expect(noSendSince(gens, "chat-1", autoContinueSnapshot)).toBe(false);
  });
});

describe("useAgent send / auto-continue invariants", () => {
  it("a new chat does not interrupt its own just-created chat id", () => {
    expect(useAgentSource).not.toMatch(/interruptIfActive\(\s*finalChatId\s*\)/);
  });

  it("auto-continue passes a send-generation guard into stream recovery", () => {
    const body = functionBody("autoContinueInterruptedTurn");
    const snapshotAt = body.indexOf("peekSendGeneration(");
    const retryAt = body.indexOf("retryStreamRecovery(chatId, config, {");
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(retryAt).toBeGreaterThan(snapshotAt);
    expect(body.slice(retryAt)).toMatch(/stillWanted:\s*\(\)\s*=>\s*noSendSince\(/);
  });

  it("stream recovery checks the guard before every release and forwards it to the hidden continue", () => {
    const body = functionBody("retryStreamRecovery");
    const releases = [...body.matchAll(/await releaseServerStream\(\);/g)];
    expect(releases.length).toBeGreaterThan(0);
    for (const release of releases) {
      const before = body.slice(0, release.index);
      expect(before.lastIndexOf("if (superseded()) return;")).toBeGreaterThan(-1);
    }
    expect(body).not.toMatch(/continueInterruptedTurn\(chatId, config\)/);
    expect(
      [...body.matchAll(/continueInterruptedTurn\(chatId, config, stillWanted\)/g)].length,
    ).toBe(releases.length);
  });

  it("the hidden continue bails before touching state when superseded", () => {
    const body = functionBody("continueInterruptedTurn");
    const guardAt = body.indexOf("if (stillWanted && !stillWanted())");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(body.indexOf("setSending(chatId, true)"));
    expect(guardAt).toBeLessThan(body.indexOf("gateway.stream("));
  });
});
