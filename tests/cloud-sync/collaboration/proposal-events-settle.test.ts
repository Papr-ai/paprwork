/** Audit A: a contributor's held copy settles as soon as its proposal is decided, not on the 5-min pull. */
import { describe, expect, it } from "vitest";

import {
  hasOwnProposalDecision,
  ownAcceptedCopies,
  pollProposalEvents,
  type ProposalEvent,
} from "../../../src/gateway/services/cloudSync/proposalEvents.js";

const ev = (over: Partial<ProposalEvent> = {}): ProposalEvent => ({
  id: "e1",
  seq: 1,
  type: "proposal.accepted",
  role: "contributor",
  requestId: "cr-1",
  sourceAppId: "src-app",
  installedAppId: "copy-app",
  title: "Add Priority",
  createdAt: "2026-11-23T00:00:00Z",
  ...over,
});

const quiet = {
  onRefresh: () => undefined,
  onNotify: () => undefined,
  onMerged: () => undefined,
  recordMerges: async () => undefined,
  onCollab: async () => undefined,
  onOwnAccepted: async () => undefined,
};

describe("settle on proposal decision", () => {
  it("only the contributor's accepted/declined events count", () => {
    expect(hasOwnProposalDecision([ev()])).toBe(true);
    expect(hasOwnProposalDecision([ev({ type: "proposal.declined" })])).toBe(true);
    expect(hasOwnProposalDecision([ev({ type: "proposal.needs_update" })])).toBe(false);
    expect(hasOwnProposalDecision([ev({ role: "owner", type: "proposal.received" })])).toBe(false);
    expect(hasOwnProposalDecision([ev({ role: "owner", type: "proposal.merged" })])).toBe(false);
  });

  it.each(["proposal.accepted", "proposal.declined"])("%s settles holds in the same poll", async (type) => {
    let settled = 0;
    const n = await pollProposalEvents("/tmp/papr-test-nonexistent", "u1", {
      ...quiet,
      fetchEvents: async () => ({ events: [ev({ type })], cursor: "1" }),
      onDecided: async () => { settled++; },
    });
    expect(n).toBe(1);
    expect(settled).toBe(1);
  });

  it("other events do not settle", async () => {
    let settled = 0;
    await pollProposalEvents("/tmp/papr-test-nonexistent", "u1", {
      ...quiet,
      fetchEvents: async () => ({ events: [ev({ role: "owner", type: "proposal.received" })], cursor: "1" }),
      onDecided: async () => { settled++; },
    });
    expect(settled).toBe(0);
  });

  it("a failed settle does not break the poll (hold kept for the next tick)", async () => {
    const n = await pollProposalEvents("/tmp/papr-test-nonexistent", "u1", {
      ...quiet,
      fetchEvents: async () => ({ events: [ev()], cursor: "1" }),
      onDecided: async () => { throw new Error("cloud down"); },
    });
    expect(n).toBe(1);
  });
});

describe("catch up a copy when its proposal is accepted (audit D)", () => {
  it("only the contributor's accepted events, deduped, with a copy id", () => {
    expect(ownAcceptedCopies([ev(), ev({ id: "e2" }), ev({ installedAppId: "copy-2" })])).toEqual(["copy-app", "copy-2"]);
    expect(ownAcceptedCopies([ev({ type: "proposal.declined" })])).toEqual([]);
    expect(ownAcceptedCopies([ev({ role: "owner", type: "proposal.merged" })])).toEqual([]);
    expect(ownAcceptedCopies([ev({ installedAppId: null })])).toEqual([]);
  });

  it("settles holds first, then catches the copy up", async () => {
    const order: string[] = [];
    await pollProposalEvents("/tmp/papr-test-nonexistent", "u1", {
      ...quiet,
      fetchEvents: async () => ({ events: [ev()], cursor: "1" }),
      onDecided: async () => { order.push("settle"); },
      onOwnAccepted: async (ids) => { order.push(`catchup:${ids.join(",")}`); },
    });
    expect(order).toEqual(["settle", "catchup:copy-app"]);
  });

  it("declined does not pull; a failed catch-up does not break the poll", async () => {
    const seen: string[][] = [];
    await pollProposalEvents("/tmp/papr-test-nonexistent", "u1", {
      ...quiet,
      fetchEvents: async () => ({ events: [ev({ type: "proposal.declined" })], cursor: "1" }),
      onDecided: async () => undefined,
      onOwnAccepted: async (ids) => { seen.push(ids); },
    });
    expect(seen).toEqual([]);
    const n = await pollProposalEvents("/tmp/papr-test-nonexistent", "u1", {
      ...quiet,
      fetchEvents: async () => ({ events: [ev()], cursor: "1" }),
      onDecided: async () => undefined,
      onOwnAccepted: async () => { throw new Error("offline"); },
    });
    expect(n).toBe(1);
  });
});
