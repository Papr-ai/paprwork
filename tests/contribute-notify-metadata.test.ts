import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gateway/websocket/index.js", () => ({ broadcast: vi.fn() }));
vi.mock("../src/gateway/utils/cloudApiClient.js", () => ({ cloudApiFetch: vi.fn() }));

import {
  appIdsToRefresh,
  noticeForEvent,
  pollProposalEvents,
  summarizeNotices,
  type ProposalEvent,
} from "../src/gateway/services/cloudSync/proposalEvents.js";
import {
  applyProposableMetadata,
  changedProposableMetadata,
  mergeTrackedMetadata,
  metadataProposalFromLocal,
  proposableMetadataHash,
} from "../src/gateway/services/cloudSync/contributeMetadataFields.js";

const ev = (over: Partial<ProposalEvent>): ProposalEvent => ({
  id: "e1",
  seq: 1,
  type: "proposal.accepted",
  role: "contributor",
  requestId: "r1",
  sourceAppId: "src",
  sourceSlug: "demo",
  installedAppId: "copy",
  title: "Add edit B",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("proposal events → refresh + notices", () => {
  it("refreshes the owner's source app or the contributor's copy", () => {
    expect(
      appIdsToRefresh([
        ev({ role: "contributor" }),
        ev({ id: "e2", role: "owner", type: "proposal.received" }),
      ]).sort(),
    ).toEqual(["copy", "src"]);
  });

  it("words notices for each side; owner needs_update is silent", () => {
    expect(noticeForEvent(ev({ type: "proposal.needs_update" }))?.body).toContain(
      "Update & re-propose",
    );
    expect(noticeForEvent(ev({ type: "proposal.declined" }))?.title).toBe("Proposal declined");
    expect(noticeForEvent(ev({ role: "owner", type: "proposal.received" }))?.title).toBe(
      "New proposal",
    );
    expect(noticeForEvent(ev({ role: "owner", type: "proposal.needs_update" }))).toBeNull();
  });

  it("keeps only the latest event per proposal and caps a burst", () => {
    const burst = [
      ev({ id: "a", type: "proposal.needs_update" }),
      ev({ id: "b", type: "proposal.accepted" }),
    ];
    expect(summarizeNotices(burst).map((n) => n.title)).toEqual(["Proposal accepted"]);
    const many = ["1", "2", "3", "4", "5"].map((i) => ev({ id: i, requestId: i }));
    const out = summarizeNotices(many, 3);
    expect(out).toHaveLength(3);
    expect(out[2].body).toContain("3 more");
  });
});

describe("pollProposalEvents", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("persists the cursor per user and only acts on new events", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "papr-events-"));
    const seen: Array<string | undefined> = [];
    const refresh = vi.fn();
    const notify = vi.fn();
    const pages = [
      { events: [], cursor: "100" },
      { events: [ev({ seq: 101 })], cursor: "101" },
    ];
    const deps = {
      fetchEvents: async (since: string | undefined) => {
        seen.push(since);
        return pages.shift() ?? { events: [], cursor: since ?? "0" };
      },
      onRefresh: refresh,
      onNotify: notify,
    };
    expect(await pollProposalEvents(dir, "bob", deps)).toBe(0);
    expect(await pollProposalEvents(dir, "bob", deps)).toBe(1);
    expect(seen).toEqual([undefined, "100"]);
    expect(refresh).toHaveBeenCalledWith(["copy"]);
    expect(notify.mock.calls[0][0][0].title).toBe("Proposal accepted");
    const saved = JSON.parse(
      await readFile(path.join(dir, "data", "cloud-proposal-events-cursor.json"), "utf8"),
    );
    expect(saved).toEqual({ bob: "101" });
  });

  it("never throws and keeps the cursor when the server errors", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "papr-events-"));
    const n = await pollProposalEvents(dir, "bob", {
      fetchEvents: async () => {
        throw new Error("boom");
      },
    });
    expect(n).toBe(0);
  });
});

describe("field-level metadata proposals", () => {
  const baseline = { title: "QA probe_2", description: "Created by agent" };

  it("proposes only fields deliberately changed since install", () => {
    const local = JSON.stringify({
      appId: "copy",
      title: "QA probe v3",
      description: "Created by agent",
      updatedAt: "2026-09-30T00:00:00Z",
      ownerUserId: "bob",
    });
    expect(metadataProposalFromLocal(local, baseline)).toEqual({ title: "QA probe v3" });
    // The install "_2" suffix alone is not an edit.
    expect(
      metadataProposalFromLocal(JSON.stringify({ appId: "copy", ...baseline }), baseline),
    ).toEqual({});
    // Older installs without a baseline propose nothing.
    expect(metadataProposalFromLocal(local, undefined)).toEqual({});
  });

  it("clearing a field or reordering tags is not an edit", () => {
    expect(changedProposableMetadata({ ...baseline, tags: ["a", "b"] }, { tags: ["b", "a"] })).toEqual(
      {},
    );
  });

  it("applies changes onto the owner's file, keeping owner ids", () => {
    const owner = JSON.stringify({
      appId: "src",
      title: "QA probe",
      description: "Owner desc",
      ownerUserId: "amy",
      updatedAt: "x",
    });
    const next = JSON.parse(applyProposableMetadata(owner, { title: "QA probe v3" })!);
    expect(next).toEqual({
      appId: "src",
      title: "QA probe v3",
      description: "Owner desc",
      ownerUserId: "amy",
      updatedAt: "x",
    });
    expect(applyProposableMetadata(owner, {})).toBeNull();
    expect(applyProposableMetadata(owner, { title: "QA probe" })).toBeNull();
  });

  it("proposal hash ignores tag order", () => {
    expect(proposableMetadataHash({ tags: ["a", "b"] })).toBe(
      proposableMetadataHash({ tags: ["b", "a"] }),
    );
  });
});

describe("track sync of metadata.json", () => {
  const local = (over: object) =>
    JSON.stringify({ appId: "copy", ownerUserId: "bob", title: "QA_2", description: "d", ...over });
  const upstream = (over: object) =>
    JSON.stringify({ appId: "src", ownerUserId: "amy", title: "QA", description: "d", ...over });
  const baselines = {
    local: { title: "QA_2", description: "d" },
    upstream: { title: "QA", description: "d" },
  };

  it("keeps the copy's ids and install suffix when the publisher didn't rename", () => {
    const out = mergeTrackedMetadata(local({}), upstream({ description: "new" }), baselines)!;
    const file = JSON.parse(out.content);
    expect(file).toMatchObject({ appId: "copy", ownerUserId: "bob", title: "QA_2", description: "new" });
    expect(out.baseline).toEqual({ title: "QA_2", description: "new" });
    expect(out.keptLocal).toEqual([]);
  });

  it("keeps a pending local edit (still proposable) over a publisher change", () => {
    const out = mergeTrackedMetadata(
      local({ title: "Mine" }),
      upstream({ title: "Theirs" }),
      baselines,
    )!;
    expect(JSON.parse(out.content).title).toBe("Mine");
    expect(out.keptLocal).toEqual(["title"]);
    expect(out.baseline.title).toBe("QA_2");
    expect(metadataProposalFromLocal(out.content, out.baseline)).toEqual({ title: "Mine" });
  });

  it("once the owner accepts the edit it stops being pending", () => {
    const out = mergeTrackedMetadata(
      local({ title: "Mine" }),
      upstream({ title: "Mine" }),
      baselines,
    )!;
    expect(out.keptLocal).toEqual([]);
    expect(metadataProposalFromLocal(out.content, out.baseline)).toEqual({});
  });

  it("discardLocal takes the publisher's field values", () => {
    const out = mergeTrackedMetadata(
      local({ title: "Mine" }),
      upstream({ title: "Theirs" }),
      baselines,
      { discardLocal: true },
    )!;
    expect(JSON.parse(out.content)).toMatchObject({ appId: "copy", title: "Theirs" });
    expect(metadataProposalFromLocal(out.content, out.baseline)).toEqual({});
  });

  it("discardLocal restores the install suffix when the publisher didn't rename", () => {
    const out = mergeTrackedMetadata(local({ title: "Mine" }), upstream({}), baselines, {
      discardLocal: true,
    })!;
    expect(JSON.parse(out.content).title).toBe("QA_2");
    expect(metadataProposalFromLocal(out.content, out.baseline)).toEqual({});
  });
});
