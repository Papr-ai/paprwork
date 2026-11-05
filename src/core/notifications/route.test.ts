/** Same cases as the Notifications UX prototype's route() tests: facts first, then your settings per source and type. */
import { describe, expect, it } from "vitest";
import { DEFAULT_NOTICE_PREFS, route, type RouteCtx, type RoutedNotice } from "./route.js";
import { mergePrefs } from "./prefs.js";
import { PAPR_SOURCES, sourceOf, typeOf } from "./sources.js";

const prefs = DEFAULT_NOTICE_PREFS;
const ctx = (o: Partial<RouteCtx> = {}): RouteCtx => ({ prefs, foreground: true, dnd: false, viewingOwner: false, ...o });
const n = (o: Partial<RoutedNotice> = {}): RoutedNotice => ({
  key: "k", kind: "job.permission", level: "priority", title: "t", forYou: true,
  source: { type: "job", id: "a", name: "Job" }, owner: { kind: "app", id: "a", name: "App" }, ...o,
});
const billing = { type: "billing" as const, id: "b", name: "Billing" };
const crm = { type: "app" as const, id: "crm", name: "CRM" };
const chat = { kind: "chat" as const, id: "c", name: "Chat" };
const done = (o: Partial<RoutedNotice> = {}) => n({ kind: "chat.done", level: "fyi", source: { type: "agent", id: "pen", name: "Pen" }, owner: chat, ...o });
const pick = (d: ReturnType<typeof route>) => [d.mark, d.lean, d.os, d.email];
const with_ = (patch: object) => mergePrefs(prefs, patch);

describe("route(): facts", () => {
  it("fyi: green dot only", () => expect(pick(route(n({ level: "fyi", kind: "proposal" }), ctx()))).toEqual(["green", false, false, "none"]));
  it("chat reply while away: desktop", () => expect(route(done(), ctx({ foreground: false })).os).toBe(true));
  it("fyi from an app's job while away: no desktop (Done › Desktop is off by default)", () =>
    expect(route(n({ level: "fyi" }), ctx({ foreground: false })).os).toBe(false));
  it("fyi while looking: nothing", () => expect(route(done(), ctx({ viewingOwner: true })).mark).toBe("none"));
  it("priority in app: blue dot, nothing pops", () => expect(pick(route(n(), ctx()))).toEqual(["blue", false, false, "none"]));
  it("priority away: desktop", () => expect(pick(route(n(), ctx({ foreground: false })))).toEqual(["blue", false, true, "none"]));
  it("priority while looking: in place", () => expect(pick(route(n(), ctx({ viewingOwner: true })))).toEqual(["blue", false, false, "none"]));
  it("priority in DND: dot only", () => expect(pick(route(n(), ctx({ dnd: true, foreground: false })))).toEqual(["blue", false, false, "none"]));
  it("jobs and apps can't send urgent", () => expect(route(n({ level: "urgent" }), ctx()).level).toBe("priority"));
  it("urgent in app: blue + Pen leans out", () => expect(pick(route(n({ level: "urgent", source: billing }), ctx()))).toEqual(["blue", true, false, "none"]));
  it("urgent billing away + DND: desktop + email", () =>
    expect(pick(route(n({ level: "urgent", source: billing }), ctx({ foreground: false, dnd: true })))).toEqual(["blue", true, true, "now"]));
  it("dedupe: no second ping", () => expect(pick(route(n(), ctx({ foreground: false, existing: { count: 1 } })))).toEqual(["blue", false, false, "none"]));
  it("dedupe keeps urgent leaning out", () => expect(route(n({ level: "urgent", source: billing }), ctx({ existing: { count: 1 } })).lean).toBe(true));
  it("status: nothing outside the thing", () => expect(pick(route(n({ level: "status" }), ctx({ foreground: false })))).toEqual(["none", false, false, "none"]));
  it("app notice not addressed to you stays inside", () => expect(route(n({ level: "fyi", source: crm, forYou: false }), ctx()).level).toBe("status"));
  it("app asks urgent: priority", () => expect(route(n({ level: "urgent", source: crm }), ctx()).level).toBe("priority"));
  it("offline (ambient): no dot, no desktop", () => {
    const d = route(n({ level: "fyi", ambient: true, source: { type: "platform", id: "p", name: "Papr Work" } }), ctx({ foreground: false }));
    expect([d.mark, d.os]).toEqual(["none", false]);
  });
  it("check-ins never pop, whatever the settings", () =>
    expect(route(n({ kind: "focus.checkin", source: { type: "agent", id: "pen", name: "Pen" } }), ctx({ foreground: false })).os).toBe(false));
});

describe("route(): sources and types", () => {
  it("maps each notice to its settings row and chip", () => {
    expect([route(done(), ctx()).source, route(done(), ctx()).type]).toEqual(["chats", "chat.done"]);
    expect(route(n({ owner: chat }), ctx()).source).toBe("chats");
    expect(route(n(), ctx()).source).toBe("apps");
    expect(route(n({ kind: "proposal" }), ctx()).type).toBe("proposal.review");
    expect(route(n({ kind: "proposal", level: "fyi" }), ctx()).type).toBe("proposal.result");
    expect(route(n({ source: crm }), ctx()).source).toBe("app:crm");
    expect(route(n({ kind: "app.update_ready", source: { type: "platform", id: "updater", name: "Papr Work" } }), ctx()).source).toBe("updates");
  });
  it("source off: kept inside, no dot", () =>
    expect(pick(route(n({ source: crm }), ctx({ prefs: with_({ sources: { "app:crm": { allow: false } } }) })))).toEqual(["none", false, false, "none"]));
  it("type off: only that type is kept inside", () => {
    const p = with_({ types: { "chats/chat.done": false } });
    expect(route(done(), ctx({ prefs: p })).level).toBe("status");
    expect(route(n({ owner: chat }), ctx({ prefs: p })).mark).toBe("blue");
  });
  it("Desktop off for Done: dot stays, no pop", () => {
    const d = route(done(), ctx({ foreground: false, prefs: with_({ sources: { chats: { done: { desktop: false } } } }) }));
    expect([d.mark, d.os]).toEqual(["green", false]);
  });
  it("Badges off: pops, no dot", () => {
    const d = route(n(), ctx({ foreground: false, prefs: with_({ sources: { apps: { needs: { badge: false } } } }) }));
    expect([d.mark, d.os]).toEqual(["none", true]);
  });
  it("settings never touch Urgent", () => {
    const p = with_({ sources: { account: { allow: false } } });
    expect(pick(route(n({ level: "urgent", source: billing, owner: { kind: "account", id: "billing", name: "Billing" } }), ctx({ prefs: p, foreground: false }))))
      .toEqual(["blue", true, true, "now"]);
  });
  it("sound: waiting on you rings, done stays quiet", () => {
    expect(route(n(), ctx({ foreground: false })).sound).toBe(true);
    expect(route(done(), ctx({ foreground: false })).sound).toBe(false);
  });
  it("Sound off for a source: still pops, silently", () => {
    const d = route(n(), ctx({ foreground: false, prefs: with_({ sources: { apps: { sound: false } } }) }));
    expect([d.os, d.sound]).toEqual([true, false]);
  });
  it("Sound off never silences Urgent", () => {
    const d = route(n({ level: "urgent", source: billing, owner: { kind: "account", id: "billing", name: "Billing" } }),
      ctx({ foreground: false, prefs: with_({ sources: { account: { sound: false } } }) }));
    expect([d.os, d.sound]).toEqual([true, true]);
  });
});

describe("server billing notices obey the Account & team chips", () => {
  const bill = { type: "billing" as const, id: "billing", name: "Billing" };
  const owner = { kind: "account" as const, id: "billing", name: "Billing", section: "billing" };
  const mk = (kind: string, level: "fyi" | "priority" | "urgent") => ({ key: kind, kind, level, title: "t", source: bill, owner });
  it("maps each kind to a Settings row and chip", () => {
    expect([sourceOf(mk("billing.low", "priority")), typeOf(mk("billing.low", "priority"))]).toEqual(["account", "billing.low"]);
    expect(typeOf(mk("member.request.seat", "priority"))).toBe("member.request");
    expect(typeOf(mk("member.approved", "fyi"))).toBe("member.result");
    expect(typeOf(mk("billing.payment_failed", "priority"))).toBe("billing.payment");
    expect(typeOf(mk("billing.ended", "fyi"))).toBe("billing.plan");
    expect(typeOf({ ...mk("connection.requested", "priority"), source: { type: "platform" as const, id: "connections", name: "Connections" } })).toBe("connection.request");
    expect(typeOf({ ...mk("proposal.accepted", "fyi"), source: { type: "platform" as const, id: "proposals", name: "Proposals" } })).toBe("proposal.result");
  });
  it("every chip a server kind maps to exists in Settings", () => {
    const account = PAPR_SOURCES.find((s) => s.id === "account")!.types.map((t) => t.id);
    for (const k of ["billing.low", "member.request.limit", "member.declined", "billing.member_cap", "billing.cancel_scheduled", "billing.topup_ok", "billing.plan_changed"]) {
      expect(account).toContain(typeOf(mk(k, k.endsWith("ok") || k.includes("plan_") || k.includes("declined") ? "fyi" : "priority")));
    }
  });
  it("turning a chip off mutes it; urgent ignores it", () => {
    const prefs = mergePrefs(DEFAULT_NOTICE_PREFS, { types: { "account/billing.low": false } });
    expect(route(mk("billing.low", "priority"), { ...ctx(), prefs }).muted).toBe(true);
    expect(route(mk("billing.topup_failed", "urgent"), { ...ctx(), prefs }).level).toBe("urgent");
  });
});
