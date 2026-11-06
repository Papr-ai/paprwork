/**
 * The Focus page on apps.papr.ai: same components, /focus-api data, mentions from the server,
 * no desktop-only actions (Later, mute menu, generate brief).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FocusPage } from "../components/Focus/page/FocusPage";
import { focusEnv } from "../components/Focus/page/focusApi";
import { useWebFeed } from "../web/useWebFeed";

const today = (() => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
const brief = { hero: { title: "Your Daily Brief", date: "Today", stats: [] }, sections: [{ type: "priorities", title: "Today's Priorities", items: [{ rank: 1, title: "Send metrics to Dale" }] }] };
const routes: Record<string, unknown> = {
  "/focus-api/api/focus/today": { briefs: [{ date: today, brief_json: JSON.stringify(brief) }], reviews: [] },
  "/focus-api/api/workspace/focus": { three: [{ id: "G1", title: "Close Tranche 2", origin: "identity", why: "" }], candidates: [], source: "pen", confirmed: true, alignedPct: null, evidence: "" },
  "/focus-api/api/workspace/goals": { goals: [], tree: [], isEmpty: true, proposedCount: 0 },
  "/focus-api/api/workspace/tasks?status=all": { tasks: [], counts: { open: 0, done: 0 } },
  "/focus-api/feed": {
    asks: [{ id: "m1", fromName: "Shawkat", title: "Write pricing copy", text: "Can you write it?", due: null, promisedAt: null, took: false, chatTitle: null }],
    waiting: [{ id: "m2", toName: "Dale Smith", title: "Q3 metrics", due: null, state: "asked", reply: null, replyAt: null, mine: null, nudgedAt: null, promisedAt: null, chatId: null, chatTitle: null, at: new Date().toISOString() }],
  },
};
const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  focusEnv.base = () => "/focus-api"; focusEnv.web = true; focusEnv.openChat = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}${init?.body ? ` ${init.body}` : ""}`);
    return new Response(JSON.stringify(routes[url] ?? { ok: true }), { headers: { "Content-Type": "application/json" } });
  }));
});

describe("Focus page (apps.papr.ai)", () => {
  it("reads /focus-api, shows the ask with a reply box and no desktop-only actions", async () => {
    const { container } = render(<FocusPage useFeed={useWebFeed} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(calls.some((c) => c.startsWith("GET /focus-api/api/focus/today"))).toBe(true);
    expect(calls.some((c) => c.startsWith("GET /focus-api/feed"))).toBe(true);
    expect(screen.getByText("Write pricing copy")).toBeTruthy();
    expect(screen.getByText("Your reply")).toBeTruthy();
    expect(screen.queryByText("Pen drafted your reply")).toBeNull();
    expect(screen.queryByRole("button", { name: "Later" })).toBeNull();
    expect(container.querySelector(".hmenu")).toBeNull();
    expect(screen.getByText("Close Tranche 2")).toBeTruthy();
    expect(screen.getByText("Q3 metrics")).toBeTruthy();
  });

  it("I'm on it sends your reply to the server", async () => {
    render(<FocusPage useFeed={useWebFeed} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const box = document.querySelector(".hdraft textarea") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "On it, Thursday." } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "I'm on it" })); await new Promise((r) => setTimeout(r, 10)); });
    expect(calls).toContain(`POST /focus-api/feed/answer ${JSON.stringify({ itemId: "m1", status: "open", reply: "On it, Thursday." })}`);
  });
});
