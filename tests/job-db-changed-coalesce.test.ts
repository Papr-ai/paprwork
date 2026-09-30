import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getJobEventHub, resetJobEventHubForTests } from "../src/gateway/services/JobEventHub.js";
import {
  publishDbChangedCoalesced,
  resetDbChangedCoalesceForTests,
  flushAllCoalescedDbChangedForTests,
} from "../src/gateway/services/jobDbChangedCoalesce.js";

describe("publishDbChangedCoalesced", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetJobEventHubForTests();
    resetDbChangedCoalesceForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges rapid db-changed events for the same dbId into one hub publish", () => {
    const events: unknown[] = [];
    getJobEventHub().subscribe((event) => {
      events.push(event);
    });

    publishDbChangedCoalesced({ dbId: "db-1", tables: ["leads"] });
    publishDbChangedCoalesced({ dbId: "db-1", tables: ["scout_run"] });
    expect(events).toHaveLength(0);

    vi.advanceTimersByTime(400);
    flushAllCoalescedDbChangedForTests();

    expect(events).toHaveLength(1);
    const payload = events[0] as {
      type: string;
      data: { dbId: string; tables: string[] };
    };
    expect(payload.type).toBe("jobs:db-changed");
    expect(payload.data.dbId).toBe("db-1");
    expect(payload.data.tables.sort()).toEqual(["leads", "scout_run"].sort());
  });
});
