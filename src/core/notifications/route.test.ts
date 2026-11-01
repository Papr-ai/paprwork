/** Same cases as the Notifications UX prototype's route() tests, minus Pen lanes (stage 2). */
import { describe, expect, it } from "vitest";
import { DEFAULT_NOTICE_PREFS, route, type RouteCtx, type RoutedNotice } from "./route.js";

const prefs = DEFAULT_NOTICE_PREFS;
const ctx = (o: Partial<RouteCtx> = {}): RouteCtx => ({ prefs, foreground: true, dnd: false, viewingOwner: false, ...o });
const n = (o: Partial<RoutedNotice> = {}): RoutedNotice => ({
  key: "k", kind: "x", level: "priority", title: "t", forYou: true,
  source: { type: "job", id: "a", name: "Job" }, owner: { kind: "app", id: "a", name: "App" }, ...o,
});
const billing = { type: "billing" as const, id: "b", name: "Billing" };
const crm = { type: "app" as const, id: "crm", name: "CRM" };
const chat = { kind: "chat" as const, id: "c", name: "Chat" };
const pick = (d: ReturnType<typeof route>) => [d.mark, d.lean, d.os, d.email];

describe("route()", () => {
  it("fyi: green dot only", () => expect(pick(route(n({ level: "fyi" }), ctx()))).toEqual(["green", false, false, "none"]));
  it("fyi chat while away: OS", () => expect(route(n({ level: "fyi", owner: chat }), ctx({ foreground: false })).os).toBe(true));
  it("fyi chat while away, OS pref off: no OS", () =>
    expect(route(n({ level: "fyi", owner: chat }), ctx({ foreground: false, prefs: { ...prefs, chatDoneOs: false } })).os).toBe(false));
  it("fyi job while away: no OS", () => expect(route(n({ level: "fyi" }), ctx({ foreground: false })).os).toBe(false));
  it("fyi while looking: nothing", () => expect(route(n({ level: "fyi" }), ctx({ viewingOwner: true })).mark).toBe("none"));
  it("priority in app: amber dot, nothing pops", () => expect(pick(route(n(), ctx()))).toEqual(["amber", false, false, "none"]));
  it("priority away: OS", () => expect(pick(route(n(), ctx({ foreground: false })))).toEqual(["amber", false, true, "none"]));
  it("priority while looking: in place", () => expect(pick(route(n(), ctx({ viewingOwner: true })))).toEqual(["amber", false, false, "none"]));
  it("priority in DND: dot only", () => expect(pick(route(n(), ctx({ dnd: true, foreground: false })))).toEqual(["amber", false, false, "none"]));
  it("priority digest pref", () => expect(route(n(), ctx({ prefs: { ...prefs, priorityEmail: true } })).email).toBe("digest"));
  it("jobs and apps can't send urgent", () => expect(route(n({ level: "urgent" }), ctx()).level).toBe("priority"));
  it("urgent in app: red + Pen leans out", () => expect(pick(route(n({ level: "urgent", source: billing }), ctx()))).toEqual(["red", true, false, "none"]));
  it("urgent billing away + DND: OS + email", () =>
    expect(pick(route(n({ level: "urgent", source: billing }), ctx({ foreground: false, dnd: true })))).toEqual(["red", true, true, "now"]));
  it("urgent platform away: OS, no email", () =>
    expect(route(n({ level: "urgent", source: { type: "platform", id: "p", name: "Papr Work" } }), ctx({ foreground: false })).email).toBe("none"));
  it("dedupe: no second ping", () => expect(pick(route(n(), ctx({ foreground: false, existing: { count: 1 } })))).toEqual(["amber", false, false, "none"]));
  it("dedupe keeps urgent leaning out", () => expect(route(n({ level: "urgent", source: billing }), ctx({ existing: { count: 1 } })).lean).toBe(true));
  it("status: nothing outside the thing", () => expect(pick(route(n({ level: "status" }), ctx({ foreground: false })))).toEqual(["none", false, false, "none"]));
  it("app default: update not for you stays inside", () => expect(route(n({ level: "fyi", source: crm, forYou: false }), ctx()).level).toBe("status"));
  it("app default: mention gets through", () => expect(route(n({ source: crm, forYou: true }), ctx()).mark).toBe("amber"));
  it("app off: even a mention stays inside", () =>
    expect(route(n({ source: crm, forYou: true }), ctx({ prefs: { ...prefs, apps: { crm: "off" } } })).level).toBe("status"));
  it("app everything: update is a green dot", () =>
    expect(route(n({ level: "fyi", source: crm, forYou: false }), ctx({ prefs: { ...prefs, apps: { crm: "all" } } })).mark).toBe("green"));
  it("app asks urgent: priority", () => expect(route(n({ level: "urgent", source: crm, forYou: true }), ctx()).level).toBe("priority"));
  it("offline (ambient): no dot, no OS", () => {
    const d = route(n({ level: "fyi", ambient: true, source: { type: "platform", id: "p", name: "Papr Work" } }), ctx({ foreground: false }));
    expect([d.mark, d.os]).toEqual(["none", false]);
  });
});
