/**
 * The native Focus page renders the same pieces the Home app did, from the Focus routes, with no iframe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../src/lib/gateway", () => ({
  gateway: { send: vi.fn(async () => ({ success: true, data: {} })), onConnectionChange: () => () => {}, isConnected: () => true },
}));
vi.mock("../components/Chat/MentionMenu", () => ({ loadTeammates: async () => [] }));

const today = (() => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
const brief = { hero: { title: "Your Daily Brief", date: "Today", stats: [] }, sections: [
  { type: "priorities", title: "Today's Priorities", items: [{ rank: 1, title: "Send metrics to Dale", why: "(G2)" }, { rank: 2, title: "Book the review", why: "(G1)" }] },
  { type: "freeform", title: "Overnight", content: "<p>Quiet <strong>night</strong>.</p><script>window.__x=1</script><img src=x onerror=alert(1)>" },
] };
const goal = { id: "G1", title: "Close Tranche 2", origin: "identity", why: "Most chat time", signals: { hours7: 3 } };
const routes: Record<string, unknown> = {
  "/api/focus/today": { briefs: [{ date: today, brief_json: JSON.stringify(brief) }], reviews: [] },
  "/api/workspace/focus": { three: [goal], candidates: [], source: "pen", confirmed: false, alignedPct: 40, evidence: "" },
  "/api/workspace/goals": { goals: [], tree: [], isEmpty: true, proposedCount: 0 },
  "/api/workspace/tasks?status=all": { tasks: [], counts: { open: 0, done: 0 } },
};
const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    return new Response(JSON.stringify(routes[path] ?? { ok: true }), { headers: { "Content-Type": "application/json" } });
  }));
});

import { FocusPage as Page } from "../components/Focus/page/FocusPage";
import { useFocusFeed } from "../components/Focus/focusBridge";
const FocusPage = () => <Page useFeed={useFocusFeed} />;

describe("Focus page (native)", () => {
  it("draws the brief, Do this first, Priority goals and Next actions — no iframe", async () => {
    const { container } = render(<FocusPage />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("heading", { name: "Your Daily Brief" })).toBeTruthy();
    expect(screen.getByText("Do this first")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Send metrics to Dale" })).toBeTruthy();
    expect(screen.getByText("Next actions")).toBeTruthy();
    expect(container.querySelector(".hthree .t3row")?.textContent).toContain("Close Tranche 2");
    expect(calls.some((c) => c.includes("/api/db/"))).toBe(false);
  });

  it("keeps the Overnight formatting but drops scripts and handlers", async () => {
    const { container } = render(<FocusPage />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const ff = container.querySelector(".freeform")!;
    expect(ff.querySelector("strong")?.textContent).toBe("night");
    expect(ff.querySelector("script, img")).toBeNull();
  });

  it("a check writes the review to /api/focus/reviews and moves the item to Reviewed", async () => {
    const { container } = render(<FocusPage />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    fireEvent.click(container.querySelector("#sections .hi-btn.check")!);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(calls.some((c) => c.startsWith("PUT /api/focus/reviews/"))).toBe(true);
    expect(container.querySelector(".reviewed-card")).toBeTruthy();
  });

  it("a row of Your three opens its goal page, and back returns to Today", async () => {
    const { container } = render(<FocusPage />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    fireEvent.click(container.querySelector(".t3row")!);
    expect(screen.getByRole("heading", { name: "Close Tranche 2" })).toBeTruthy();
    fireEvent.click(container.querySelector(".t3back")!);
    expect(container.querySelector(".hthree")).toBeTruthy();
  });
});
