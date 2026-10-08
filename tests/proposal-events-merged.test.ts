/** Roles plan: publisher hears about (and pulls) a Maintainer's merge. */
import { describe, expect, it } from "vitest";

import {
  mergedSourceAppIds,
  noticeForEvent,
  pollProposalEvents,
  type ProposalEvent,
} from "../src/gateway/services/cloudSync/proposalEvents.js";

const merged = (over: Partial<ProposalEvent> = {}): ProposalEvent => ({
  id: "e1",
  seq: 1,
  type: "proposal.merged",
  role: "owner",
  requestId: "cr-1",
  sourceAppId: "src-app",
  sourceSlug: "spike-lab-2",
  installedAppId: "copy-app",
  title: "Fix chart labels",
  detail: { publishedDirectly: true },
  createdAt: "2026-10-08T00:00:00Z",
  ...over,
});

describe("proposal.merged", () => {
  it("notifies the publisher in plain words", () => {
    const n = noticeForEvent(merged());
    expect(n?.title).toBe("Changes published to your app");
    expect(n?.appId).toBe("src-app");
    expect(noticeForEvent(merged({ detail: {} }))?.title).toBe("Proposal accepted by a Maintainer");
  });

  it("only owner-side merged events trigger a pull", () => {
    expect(
      mergedSourceAppIds([merged(), merged({ id: "e2", role: "contributor" }), merged({ id: "e3", type: "proposal.received" })]),
    ).toEqual(["src-app"]);
  });

  it("poll hands merged apps to onMerged", async () => {
    const pulled: string[][] = [];
    const n = await pollProposalEvents("/tmp/papr-test-nonexistent", "u1", {
      fetchEvents: async () => ({ events: [merged()], cursor: "1" }),
      onRefresh: () => undefined,
      onNotify: () => undefined,
      onMerged: (ids) => pulled.push(ids),
    }).catch(() => -1);
    expect(n).toBe(1);
    expect(pulled).toEqual([["src-app"]]);
  });
});
