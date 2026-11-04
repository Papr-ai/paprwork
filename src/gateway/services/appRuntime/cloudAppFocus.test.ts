/**
 * apps.papr.ai Focus: memory-server shapes → the Focus page's shapes, and the signed-in home page.
 */
import { describe, expect, it } from "vitest";
import { applyPicks, toFeed, toFocusState, toGoals, toTasks, toToday, withReview } from "./cloudAppFocusMap.js";
import { buildDiscoverHtml } from "./cloudAppDiscoverHtml.js";
import { isReservedCloudPathSegment } from "./cloudAppHostContext.js";

const state = {
  three: [{ id: "G1", title: "Raise", origin: "identity", why: "" }, { id: "G2", title: "Ship", origin: "identity", why: "" }],
  candidates: [{ id: "G3", title: "Hire", origin: "identity", why: "" }],
  source: "pen", confirmed: false, pickedAt: "2026-11-03T10:00:00.000Z",
};

describe("Focus on the web: mapping", () => {
  it("briefs become rows and their reviews flatten to the page's shape", () => {
    const out = toToday([
      { date: "2026-11-04", brief: { hero: { title: "Hi" } }, updatedAt: "t", reviews: [{ itemKey: "a", status: "complete" }, { itemKey: "b", status: "weird" }] },
      { date: "2026-11-03", brief: null },
    ]);
    expect(out.briefs).toEqual([{ date: "2026-11-04", brief_json: JSON.stringify({ hero: { title: "Hi" } }) }]);
    expect(out.reviews).toEqual([{ item_key: "a", status: "complete", note: null, updated_at: "t" }]);
  });

  it("a review replaces the item's previous one; undo removes it", () => {
    const r = withReview([{ itemKey: "a", status: "complete" }, { itemKey: "b", status: "irrelevant" }], "a", { status: "irrelevant", note: "n" });
    expect(r).toEqual([{ itemKey: "b", status: "irrelevant" }, { itemKey: "a", status: "irrelevant", note: "n" }]);
    expect(withReview(r, "a", null)).toEqual([{ itemKey: "b", status: "irrelevant" }]);
  });

  it("goals build the L1 → L2 tree in priority order; archived goals go to the archive", () => {
    const g = toGoals([
      { goalId: "G2", title: "Child", level: "L2", parentId: "G1", priority: 1, status: "on-track" },
      { goalId: "G1", title: "Root", level: "L1", priority: 2, status: "proposed" },
      { goalId: "G0", title: "Old", level: "L1", archived: true, status: "done" },
    ]);
    expect(g.tree.map((x) => x.id)).toEqual(["G1"]);
    expect(g.tree[0].children?.map((x) => x.id)).toEqual(["G2"]);
    expect(g.archive.map((x) => x.id)).toEqual(["G0"]);
    expect(g.proposedCount).toBe(1);
    expect(g.isEmpty).toBe(false);
  });

  it("tasks count open and done, and dropped ones disappear", () => {
    const t = toTasks([{ taskId: "a", title: "A", status: "open" }, { taskId: "b", title: "B", status: "done" }, { taskId: "c", status: "dropped" }]);
    expect(t.tasks.map((x) => x.id)).toEqual(["a", "b"]);
    expect(t.counts).toEqual({ open: 1, done: 1 });
  });

  it("Your three: the desktop's state, unless the web picked after it", () => {
    expect(toFocusState(null)).toBeNull();
    expect((toFocusState({ state }) as typeof state).three.map((g) => g.id)).toEqual(["G1", "G2"]);
    const old = toFocusState({ state, picks: [{ id: "G3", goalId: "G3" }], picksBy: "web", picksAt: "2026-11-02T00:00:00Z" }) as typeof state;
    expect(old.three.map((g) => g.id)).toEqual(["G1", "G2"]);
    const fresh = toFocusState({ state, picks: [{ id: "G3", goalId: "G3" }], picksBy: "web", picksAt: "2026-11-04T00:00:00Z" }) as typeof state;
    expect(fresh.three.map((g) => g.id)).toEqual(["G3"]);
    expect(fresh.candidates.map((g) => g.id)).toEqual(["G1", "G2"]);
  });

  it("a goal the user writes on the web shows with its own title", () => {
    const s = applyPicks(state, [{ id: "F-1", title: "Run a marathon", target: "Sub 4h" }, { id: "G2", goalId: "G2", title: "Ship v2" }]);
    const three = s.three as Array<Record<string, unknown>>;
    expect(three[0]).toMatchObject({ id: "F-1", title: "Run a marathon", origin: "custom", target: "Sub 4h" });
    expect(three[1]).toMatchObject({ id: "G2", title: "Ship v2", edited: true });
    expect(s.confirmed).toBe(true);
  });

  it("mentions: asks of you, and Waiting on skips quiet ones you never sent", () => {
    const f = toFeed(
      [{ id: "m1", fromName: "Shawkat", text: "Pricing copy?", action: { title: "Write pricing copy", due: "2026-11-05" }, progress: "in_progress", promisedAt: "2026-11-05T09:00:00Z" }],
      [{ id: "m2", toName: "Dale", text: "Metrics?", notified: true, reply: { text: "On it", at: "t" }, thread: [{ by: "from", text: "ping", at: "t0" }] },
        { id: "m3", toName: "Quiet", text: "x", notified: false }],
    );
    expect(f.asks[0]).toMatchObject({ id: "m1", title: "Write pricing copy", due: "2026-11-05", took: true });
    expect(f.waiting.map((w) => w.id)).toEqual(["m2"]);
    expect(f.waiting[0]).toMatchObject({ state: "in_progress", reply: "On it", mine: { by: "from", text: "ping", at: "t0" } });
  });
});

describe("Focus on the web: home page", () => {
  const base = { apps: [], mine: null, focusedIsPublic: true, publicBaseUrl: "https://apps.papr.ai" };

  it("signed in: Focus is the home tab, Discover one tab away, never indexed", () => {
    const html = buildDiscoverHtml({ ...base, view: "focus", signedIn: true, displayName: "Amir" });
    expect(html).toContain('<div id="focus-root">');
    expect(html).toContain('src="/focus/_/focus.js"');
    expect(html).toContain('href="/focus/_/focus.css"');
    expect(html).toMatch(/<a href="\/" class="on" aria-current="page">Focus<\/a><a href="\/my-apps">My apps<\/a><a href="\/discover">Discover<\/a>/);
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain('class="btn btn--solid get"');
  });

  it("signed out: Discover stays at / with no Focus tab or bundle", () => {
    const html = buildDiscoverHtml({ ...base, view: "discover", signedIn: false });
    expect(html).not.toContain("focus.js");
    expect(html).not.toContain(">Focus<");
    expect(html).toContain('<a href="/" class="on" aria-current="page">Discover</a>');
    expect(html).toContain('class="btn btn--solid get"');
  });

  it("focus and focus-api can't be taken as a namespace", () => {
    expect(isReservedCloudPathSegment("focus")).toBe(true);
    expect(isReservedCloudPathSegment("focus-api")).toBe(true);
  });
});
