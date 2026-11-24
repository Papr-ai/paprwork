import { describe, expect, it } from "vitest";
import type { JobRecord } from "../jobs/types.js";
import {
  activeDelegationsForChat,
  isCloudRunAwaitingDelegations,
  markCloudRunAwaiting,
  waitForDelegations,
} from "./cloudRunDelegationWait.js";

const job = (id: string, status: string, extra: Partial<JobRecord> = {}) =>
  ({ id, status, type: "subagent", reportChatId: "c1", ...extra }) as unknown as JobRecord;

describe("cloud run waits for its helpers", () => {
  it("only counts active helpers that report to this chat", () => {
    const jobs = [
      job("a", "running"),
      job("b", "completed"),
      job("c", "running", { reportChatId: "other" }),
      job("d", "running", { type: "agent" } as Partial<JobRecord>),
    ];
    expect(activeDelegationsForChat(jobs, "c1").map((j) => j.id)).toEqual(["a"]);
  });

  it("returns once every helper finished, with its outcome", async () => {
    let polls = 0;
    const states: Record<string, string[]> = { a: ["running", "completed"], b: ["failed"] };
    const finished = await waitForDelegations(
      ["a", "b"],
      async (id) => job(id, states[id][Math.min(polls, states[id].length - 1)]),
      { timeoutMs: 10_000, pollMs: 1, sleep: async () => void polls++ },
    );
    expect(finished).toEqual(
      expect.arrayContaining([
        { id: "a", outcome: "completed" },
        { id: "b", outcome: "failed" },
      ]),
    );
  });

  it("gives up at the deadline and leaves still-running helpers out", async () => {
    const finished = await waitForDelegations(["a"], async () => job("a", "running"), {
      timeoutMs: 0,
      sleep: async () => {},
    });
    expect(finished).toEqual([]);
  });

  it("marks the chat so the desktop-style trigger stays out of the way", () => {
    markCloudRunAwaiting("c9", true);
    expect(isCloudRunAwaitingDelegations("c9")).toBe(true);
    markCloudRunAwaiting("c9", false);
    expect(isCloudRunAwaitingDelegations("c9")).toBe(false);
  });
});
