import { describe, expect, it, vi } from "vitest";
import {
  fetchBuilders,
  formatCredits,
  isBuilderRoles,
  isRoleBuilder,
  monthlySeatTotal,
  describeSeatChange,
  planLabel,
  seatValue,
  setBuilder,
  usageByUser,
  type BuildersView,
} from "../src/core/utils/paprCreditSeats.js";

const view = (over: Partial<BuildersView> = {}): BuildersView => ({
  organizationId: "org1", period: "2026-10", plan: "cloud_plus", seats: 2, stripeSeats: 2,
  seatsInSync: true, creditsPerBuilder: 150_000, memberCap: 25_000,
  builderUsage: [{ userId: "owner1", roles: ["owner"], seat: true, grant: 150_000, used: 1200, state: "ok", overageCredits: 0, overageUsd: 0 }],
  members: ["m1"],
  memberUsage: [{ userId: "m1", roles: ["member"], seat: false, grant: 0, used: 500, state: "overage", overageCredits: 500, overageUsd: 0.65 }],
  ...over,
});

describe("paprCreditSeats", () => {
  it("classifies builders by role", () => {
    expect(isBuilderRoles(["member", "expert"])).toBe(true);
    expect(isBuilderRoles(["member"])).toBe(false);
    expect(isRoleBuilder(["admin"])).toBe(true);
    expect(isRoleBuilder(["member", "expert"])).toBe(false);
  });

  it("merges builder and member usage by user", () => {
    const m = usageByUser(view());
    expect(m.get("owner1")?.seat).toBe(true);
    expect(m.get("m1")?.overageUsd).toBe(0.65);
    expect(usageByUser(null).size).toBe(0);
  });

  it("formats credits", () => {
    expect(formatCredits(150_000)).toBe("150K");
    expect(formatCredits(12_400)).toBe("12.4K");
    expect(formatCredits(1_500_000)).toBe("1.5M");
    expect(formatCredits(42)).toBe("42");
  });

  it("calls the memory server with the session token", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(view()), { status: 200 }));
    await fetchBuilders("https://m", "r:tok", f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://m/v1/credits/builders");
    expect((init.headers as Record<string, string>)["X-Session-Token"]).toBe("r:tok");
  });

  it("posts the builder flag and surfaces server errors", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ builder: true }), { status: 200 }));
    await setBuilder("https://m", "r:tok", "abc123", true, ok as unknown as typeof fetch);
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://m/v1/credits/builders/abc123");
    expect(JSON.parse(String(init.body))).toEqual({ builder: true });

    const bad = vi.fn(async () => new Response(JSON.stringify({ detail: "org owner or admin required" }), { status: 403 }));
    await expect(setBuilder("https://m", "r:tok", "abc123", false, bad as unknown as typeof fetch))
      .rejects.toThrow("org owner or admin required");
    await expect(setBuilder("https://m", "r:tok", "../x", true, ok as unknown as typeof fetch)).rejects.toThrow("Invalid user id");
  });

  const opts = [
    { key: "cloud", name: "Cloud", price: 30, credits: 30_000 },
    { key: "cloud_plus", name: "Cloud Max 5x", price: 100, credits: 150_000 },
    { key: "cloud_max", name: "Cloud Max 20x", price: 300, credits: 500_000 },
  ];

  it("totals seats across plans", () => {
    expect(monthlySeatTotal(view({ planOptions: opts, seatPlans: { cloud_plus: 1, cloud_max: 1 } }))).toBe(400);
    expect(monthlySeatTotal(view({ planOptions: opts }))).toBe(200);   // falls back to plan x seats
  });

  it("reads a person's seat value", () => {
    const v = view({ planOptions: opts });
    expect(seatValue(v, undefined, false)).toBe("member");
    expect(seatValue(v, { ...v.builderUsage[0], plan: "cloud_max" }, true)).toBe("cloud_max");
    expect(seatValue(v, v.builderUsage[0], true)).toBe("cloud_plus");
  });

  it("says which seat changes charge now", () => {
    const v = view({ planOptions: opts });
    const add = describeSeatChange(v, "member", "cloud_max");
    expect(add.chargesNow).toBe(true);
    expect(add.deltaPerMonth).toBe(300);
    expect(add.summary).toMatch(/Adds a Cloud Max 20x seat: \+\$300\/mo/);
    expect(describeSeatChange(v, "cloud", "cloud_max")).toMatchObject({ chargesNow: true, deltaPerMonth: 270 });
    const down = describeSeatChange(v, "cloud_max", "cloud");
    expect(down).toMatchObject({ chargesNow: false, deltaPerMonth: -270 });
    expect(down.summary).toMatch(/Keeps Cloud Max 20x credits until then/);
    expect(describeSeatChange(v, "cloud", "member")).toMatchObject({ chargesNow: false });
    expect(planLabel(v, "cloud_max")).toBe("Max 20x · $300");
    expect(planLabel(v, "member")).toBe("Pay as you go");
  });

  it("sends the seat plan", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ when: "now" }), { status: 200 }));
    await setBuilder("https://m", "r:tok", "abc123", true, ok as unknown as typeof fetch, "cloud_max");
    const [, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ builder: true, plan: "cloud_max" });
    await expect(setBuilder("https://m", "r:tok", "abc123", false, ok as unknown as typeof fetch, "cloud")).rejects.toThrow("Invalid plan");
  });
});
