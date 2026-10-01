import { describe, expect, it } from "vitest";
import {
  usesSharedData,
  assertValidCopyState,
  copyAxesFromLineage,
  resolveCopyBar,
  type CopyFacts,
  type CopyState,
} from "../ui/utils/copyState";

/** Facts for a quiet copy; each case overrides what it's about. */
const facts = (o: Partial<CopyFacts> = {}): CopyFacts => ({
  live: true,
  hasLocalEdits: false,
  hasUnproposedEdits: false,
  hasUnpublishedEdits: false,
  publisherAhead: false,
  pullState: "idle",
  lastPublishFailed: false,
  proposal: "none",
  busy: false,
  ...o,
});
const community = (o: Partial<CopyFacts> = {}): CopyState =>
  ({ ...facts(o), link: "linked", dataMode: "own", origin: "community", sourceSlug: "papr/doctor" });
const teamData = (o: Partial<CopyFacts> = {}): CopyState =>
  ({ ...facts(o), link: "linked", dataMode: "team", origin: "team", sourceSlug: "papr/doctor" });
const teamOwn = (o: Partial<CopyFacts> = {}): CopyState =>
  ({ ...facts(o), link: "linked", dataMode: "own", origin: "team", sourceSlug: "papr/doctor" });
const detached = (o: Partial<CopyFacts> = {}): CopyState =>
  ({ ...facts(o), link: "detached", dataMode: "own", origin: "team", sourceSlug: "papr/doctor" });

describe("copyAxesFromLineage (today's lineage → v5 axes)", () => {
  it("fork → detached, own data", () => {
    expect(copyAxesFromLineage({ mode: "fork", databasePolicy: "forked" })).toMatchObject({ link: "detached", dataMode: "own" });
  });
  it("track + shared → linked team copy on team data", () => {
    expect(copyAxesFromLineage({ mode: "track", databasePolicy: "shared" })).toEqual({ link: "linked", dataMode: "team", origin: "team" });
  });
  it("track + forked (Community collaborate) → linked, own data, community", () => {
    expect(copyAxesFromLineage({ mode: "track", databasePolicy: "forked", sourceAudience: "community" })).toEqual({ link: "linked", dataMode: "own", origin: "community" });
  });
  it("track + forked on a team app → linked team copy on its own data", () => {
    expect(copyAxesFromLineage({ mode: "track", databasePolicy: "forked", sourceAudience: "team" })).toEqual({ link: "linked", dataMode: "own", origin: "team" });
  });
  it("never shows team data on a detached or Community copy", () => {
    expect(copyAxesFromLineage({ mode: "fork", databasePolicy: "shared" }).dataMode).toBe("own");
    expect(copyAxesFromLineage({ mode: "track", databasePolicy: "shared", sourceAudience: "community" }).dataMode).toBe("own");
  });
  it("older track installs without databasePolicy were shared team copies", () => {
    expect(copyAxesFromLineage({ mode: "track" })).toEqual({ link: "linked", dataMode: "team", origin: "team" });
  });
});

describe("usesSharedData (routing guard, same rule as lineageUsesSharedPrimaryDatabase)", () => {
  it("follows databasePolicy, falling back to mode for older installs", () => {
    expect(usesSharedData({ mode: "track", databasePolicy: "shared" })).toBe(true);
    expect(usesSharedData({ mode: "track", databasePolicy: "forked" })).toBe(false);
    expect(usesSharedData({ mode: "track" })).toBe(true);
    expect(usesSharedData({ mode: "fork" })).toBe(false);
    expect(usesSharedData(null)).toBe(false);
  });
  it("still reports shared data where the display axes say own (guards must not trust display)", () => {
    const l = { mode: "track" as const, databasePolicy: "shared" as const, sourceAudience: "community" as const };
    expect(copyAxesFromLineage(l).dataMode).toBe("own");
    expect(usesSharedData(l)).toBe(true);
  });
});

describe("invariants", () => {
  it("rejects a detached copy on team data", () => {
    expect(() => assertValidCopyState({ link: "detached", dataMode: "team", origin: "team" })).toThrow();
  });
  it("rejects team data on a Community copy", () => {
    expect(() => assertValidCopyState({ link: "linked", dataMode: "team", origin: "community" })).toThrow();
  });
});

describe("primary: Publish when the data is yours, Propose when it's the team's", () => {
  it("Community copy publishes to its own link", () => {
    const bar = resolveCopyBar(community({ hasUnpublishedEdits: true }));
    expect(bar.primary).toMatchObject({ kind: "publish", disabled: false });
    expect(bar.link).toBe("own_copy");
  });
  it("team copy on team data proposes, link is the team app", () => {
    const bar = resolveCopyBar(teamData({ hasLocalEdits: true, hasUnproposedEdits: true }));
    expect(bar.primary).toMatchObject({ kind: "propose", disabled: false });
    expect(bar.link).toBe("team_app");
  });
  it("team copy on own data publishes", () => {
    expect(resolveCopyBar(teamOwn({ live: false })).primary).toMatchObject({ kind: "publish", disabled: false });
  });
  it("Propose disabled with nothing to send, or when proposals are closed", () => {
    expect(resolveCopyBar(teamData()).primary.disabled).toBe(true);
    expect(resolveCopyBar(teamData({ hasLocalEdits: true, hasUnproposedEdits: true, proposalsClosed: true })).primary.disabled).toBe(true);
  });
  it("both disabled during a conflict", () => {
    expect(resolveCopyBar(community({ pullState: "conflict", hasUnpublishedEdits: true })).primary.disabled).toBe(true);
    expect(resolveCopyBar(teamData({ pullState: "conflict", hasLocalEdits: true, hasUnproposedEdits: true })).primary.disabled).toBe(true);
  });
});

describe("chip priority (one list for every copy)", () => {
  const label = (s: CopyState) => resolveCopyBar(s).chip.label;
  it("conflict beats everything", () => {
    expect(label(community({ pullState: "conflict", publisherAhead: true, lastPublishFailed: true }))).toBe("Update conflicts");
  });
  it("publish failure beats publisher updates", () => {
    expect(label(community({ lastPublishFailed: true, publisherAhead: true }))).toBe("Last publish failed");
  });
  it("publisher updates beat local edits", () => {
    expect(label(community({ publisherAhead: true, hasUnpublishedEdits: true }))).toBe("Publisher has updates");
  });
  it("Community copy with edits: not published (never 'not proposed')", () => {
    expect(label(community({ hasLocalEdits: true, hasUnproposedEdits: true, hasUnpublishedEdits: true }))).toBe("Edits not published");
  });
  it("team data with edits: not proposed", () => {
    expect(label(teamData({ hasLocalEdits: true, hasUnproposedEdits: true }))).toBe("Edits not proposed");
  });
  it("declined / accepted / sent", () => {
    expect(label(community({ proposal: "rejected" }))).toBe("Proposal declined");
    expect(label(community({ proposal: "approved" }))).toBe("Proposal accepted");
    expect(label(community({ proposal: "pending" }))).toBe("Proposal sent");
  });
  it("draft copy says so; quiet copies say up to date", () => {
    expect(label(community({ live: false }))).toBe("Not on the web yet");
    expect(label(community())).toBe("Up to date");
    expect(label(teamData())).toBe("Same as the team's app");
  });
});

describe("detached copies", () => {
  it("never show publisher updates, proposals, or the origin menu", () => {
    const bar = resolveCopyBar(detached({ publisherAhead: true, proposal: "pending" }));
    expect(bar.chip.label).toBe("Up to date");
    expect(bar.badge).toEqual({ kind: "fork_mark" });
    expect(bar.menu).toEqual([]);
    expect(bar.primary.kind).toBe("publish");
  });
});

describe("origin menu", () => {
  it("team copies get the Data row, Community copies don't", () => {
    expect(resolveCopyBar(teamData()).menu).toContain("data");
    expect(resolveCopyBar(community()).menu).not.toContain("data");
  });
  it("badge dot follows publisher updates", () => {
    expect(resolveCopyBar(community({ publisherAhead: true })).badge).toMatchObject({ kind: "origin", dot: true, icon: "globe" });
  });
});

describe("property: every valid state yields exactly one sane bar", () => {
  const bools = [true, false];
  it("holds across the grid", () => {
    let n = 0;
    for (const shape of [community, teamData, teamOwn, detached])
      for (const live of bools) for (const edits of bools) for (const ahead of bools) for (const failed of bools)
        for (const pullState of ["idle", "pulling", "conflict"] as const)
          for (const proposal of ["none", "pending", "approved", "rejected", "needs_update"] as const) {
            const s = shape({ live, hasLocalEdits: edits, hasUnproposedEdits: edits, hasUnpublishedEdits: edits, publisherAhead: ahead, lastPublishFailed: failed, pullState, proposal });
            const bar = resolveCopyBar(s);
            n++;
            expect(bar.primary.kind).toBe(s.dataMode === "team" ? "propose" : "publish");
            if (s.link === "detached") {
              expect(bar.chip.action).not.toBe("get_updates");
              expect(bar.chip.label).not.toMatch(/Proposal/);
            }
            if (s.dataMode !== "team") expect(bar.chip.label).not.toBe("Edits not proposed");
            if (pullState !== "idle") expect(bar.primary.disabled).toBe(true);
          }
    expect(n).toBe(960);
  });
});
