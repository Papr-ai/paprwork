/** Audit A: a contributor's held copy settles as soon as its proposal is decided, not on the 5-min pull. */
import { describe, expect, it } from "vitest";

import {
  hasOwnProposalDecision,
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
