import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/gateway", () => ({ gateway: { send: vi.fn(() => Promise.resolve()), isConnected: () => false } }));
vi.mock("../stores/tabStore", () => ({ useTabStore: { getState: () => ({ tabs: [], activeTabId: null }), subscribe: vi.fn() } }));

import { billingMark, billingNeedsYou } from "../stores/noticeStore";
import type { Notice } from "../../src/core/types/notices";

const n = (key: string, mark: Notice["mark"], owner: Partial<Notice["owner"]> = {}): Notice => ({
  id: key, key, kind: key, type: "condition", level: mark === "green" ? "fyi" : "priority", mark, title: key, count: 1,
  createdAt: "", updatedAt: "", source: { type: "billing", id: "billing", name: "Billing" },
  owner: { kind: "account", id: "billing", name: "Billing", ...owner },
});
const s = (notices: Notice[]) => ({ notices, prefs: {} as never, tick: 0, setNotices: () => {} });

describe("Billing dots come from notices", () => {
  it("news is a green dot on Billing only: the avatar stays quiet", () => {
    const st = s([n("billing.topup_ok:1", "green")]);
    expect(billingMark(st)).toBe("green");
    expect(billingNeedsYou(st)).toBe(false);
  });
  it("something waiting on you lights the tab and the avatar", () => {
    const st = s([n("billing.topup_ok:1", "green"), n("member.request:u:seat", "blue", { section: "billing" })]);
    expect(billingMark(st)).toBe("blue");
    expect(billingNeedsYou(st)).toBe(true);
  });
  it("other account notices (Connections) don't light Billing", () => {
    expect(billingMark(s([n("connection:1", "blue", { id: "connections", section: "connections" })]))).toBe("none");
  });
});
