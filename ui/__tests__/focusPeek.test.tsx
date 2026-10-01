/**
 * Focus peek — the rail logo's hover card is a one-glance read: agent status, your three on one
 * line each with this week's hours, share of the week, Open Focus. Rows open their own goal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FocusPeek, fmtHours, paceOf, shortTitle } from "../components/Sidebar/FocusPeek";

const STATE = {
  three: [
    { id: "g1", title: "Close Tranche 2", target: "$1.25M raised", due: "2026-11-30", why: "Top priority", signals: { hours7: 7.64 } },
    { id: "g6", title: "papr-embed-v2 beats v1", why: "Stage-A run is live", signals: { hours7: 0.4 } },
    { id: "g8", title: "Write daily", why: "Distribution habit", signals: { hours7: 0 } },
  ],
  alignedPct: 68,
  next: { title: "Decide on the Data Room blurb", goalId: "g1" },
};

afterEach(() => vi.restoreAllMocks());

describe("fmtHours", () => {
  it("formats hours for a glance", () => {
    expect(fmtHours(7.64)).toBe("7.6h");
    expect(fmtHours(0.4)).toBe("<1h");
    expect(fmtHours(0)).toBe("—");
    expect(fmtHours(undefined)).toBe("—");
  });
});

describe("shortTitle / paceOf", () => {
  it("cuts long goal names to a readable first clause", () => {
    expect(shortTitle("Close pre-seed Tranche 1 and build a $1-2M-lead-capable pipeline")).toBe("Close pre-seed Tranche 1");
    expect(shortTitle("Distribution via content creation, build following")).toBe("Distribution via content");
    expect(shortTitle("Write daily")).toBe("Write daily");
  });
  it("reads pace from time this week", () => {
    expect([paceOf(2), paceOf(0.4), paceOf(0), paceOf()]).toEqual(["on", "risk", "off", "off"]);
  });
});

describe("FocusPeek", () => {
  it("shows status, three one-line goals with hours, share of week, and no next-step card", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(STATE), { status: 200 }));
    render(<FocusPeek status="Pen is working · 2 chats" onOpen={() => {}} />);
    expect(await screen.findByText("Close Tranche 2")).toBeTruthy();
    expect(screen.getByText("Pen is working · 2 chats")).toBeTruthy();
    expect(screen.getByLabelText("7.6h this week").className).toContain("is-on");
    expect(screen.getByLabelText("<1h this week").className).toContain("is-risk");
    expect(screen.getByText("68%")).toBeTruthy();
    expect(screen.queryByText("Decide on the Data Room blurb")).toBeNull();
    expect(screen.getByText("Close Tranche 2").closest("button")?.getAttribute("title")).toContain("$1.25M raised");
  });

  it("opens one goal from its row and Focus from the footer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(STATE), { status: 200 }));
    const onOpen = vi.fn();
    render(<FocusPeek status="Pen's picks" onOpen={onOpen} />);
    fireEvent.click(await screen.findByText("Write daily"));
    expect(onOpen).toHaveBeenLastCalledWith("g8");
    fireEvent.click(screen.getByText("Open Focus"));
    expect(onOpen).toHaveBeenLastCalledWith();
  });
});
