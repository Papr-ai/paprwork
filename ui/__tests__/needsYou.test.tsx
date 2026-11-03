/**
 * Needs you in Focus and the count on Pen: the same list. Later and Mute take things out of both
 * (the dot stays on the thing); Urgent can't be put off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const sent: [string, unknown][] = [];
vi.mock("../src/lib/gateway", () => ({
  gateway: {
    send: vi.fn(async (type: string, payload: unknown) => {
      sent.push([type, payload]);
      return { success: true, data: type === "notifications:mute" ? { until: new Date(Date.now() + 3_600_000).toISOString() } : { until: null } };
    }),
    onConnectionChange: () => () => {},
    isConnected: () => true,
  },
}));
vi.mock("../stores/noticeOs", () => ({ openNoticeOwner: vi.fn() }));
vi.mock("../lib/ensureSettingsTab", () => ({ ensureSettingsTab: vi.fn() }));

import { useNoticeStore } from "../stores/noticeStore";
import { NeedsYou } from "../components/Focus/NeedsYou";
import { RailItem } from "../components/Sidebar/RailItem";
import { useNeedsYouCount } from "../stores/useNeedsYou";
import { openNoticeOwner } from "../stores/noticeOs";
import { DEFAULT_NOTICE_PREFS, mergePrefs } from "../../src/core/notifications/prefs";
import type { Notice } from "../../src/core/types/notices";

const n = (o: Partial<Notice> = {}): Notice => ({
  id: o.key ?? "k", key: "key.request:c:GITHUB_TOKEN", kind: "key.request", type: "condition", level: "priority", mark: "blue", count: 1,
  title: "Pen needs GITHUB_TOKEN", source: { type: "agent", id: "pen", name: "Pen" }, owner: { kind: "chat", id: "c", name: "Outreach" },
  actions: [{ label: "Add key", intent: "open" }], createdAt: DAY_AGO(), updatedAt: new Date().toISOString(), ...o,
});
/** A chat's key request only comes into Focus once it has waited a day; fixtures default to that. */
function DAY_AGO() { return new Date(Date.now() - 25 * 3_600_000).toISOString(); }
const billing = n({ key: "billing.out", kind: "billing.out", level: "urgent", title: "Out of Papr credit", source: { type: "billing", id: "credits", name: "Billing" },
  owner: { kind: "account", id: "settings", name: "Billing" }, actions: [{ label: "Top up", intent: "billing.topup" }] });
const set = (notices: Notice[], prefs = DEFAULT_NOTICE_PREFS) => act(() => useNoticeStore.getState().setNotices(notices, prefs));

function Pen() {
  return <RailItem label="Focus" icon={<span />} onClick={() => {}} count={useNeedsYouCount()} />;
}

describe("Needs you", () => {
  beforeEach(() => { sent.length = 0; useNoticeStore.setState({ notices: [], prefs: DEFAULT_NOTICE_PREFS }); });

  it("a fresh key request in a chat stays on the chat's dot: not in Focus, no count on Pen", () => {
    set([n({ createdAt: new Date().toISOString() })]);
    const { container } = render(<><NeedsYou /><Pen /></>);
    expect(container.querySelector(".needs-you")).toBeNull();
    expect(container.querySelector(".rail-btn__count")).toBeNull();
  });
  it("promoted after a day, with the reason", () => {
    set([n()]);
    render(<NeedsYou />);
    expect(screen.getByText(/Waiting since yesterday/)).toBeTruthy();
  });
  it("empty: no section at all, and no count on Pen", () => {
    const { container } = render(<><NeedsYou /><Pen /></>);
    expect(container.querySelector(".needs-you")).toBeNull();
    expect(container.querySelector(".rail-btn__count")).toBeNull();
  });

  it("lists blue notices (not green), leads with Urgent, and Pen counts the same", () => {
    const { container } = render(<><NeedsYou /><Pen /></>);
    set([n(), n({ key: "done", kind: "chat.done", level: "fyi", mark: "green", title: "Reply ready" }), billing]);
    expect(screen.getByText("You're blocked")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Out of Papr credit" })).toBeTruthy();
    expect(screen.getByText("Pen needs GITHUB_TOKEN")).toBeTruthy();
    expect(screen.queryByText("Reply ready")).toBeNull();
    expect(container.querySelector(".rail-btn__count")?.textContent).toBe("2");
  });

  it("the button opens the thing", () => {
    render(<NeedsYou />);
    set([n()]);
    fireEvent.click(screen.getByText("Add key"));
    expect(openNoticeOwner).toHaveBeenCalledWith(expect.objectContaining({ id: "c" }), "key.request:c:GITHUB_TOKEN");
  });

  it("… › Later asks the gateway and confirms with Undo", async () => {
    render(<NeedsYou />);
    set([n()]);
    fireEvent.click(screen.getByLabelText("Options"));
    expect(screen.getByText(/^Back (3 PM today|tomorrow 9 AM)$/)).toBeTruthy();
    fireEvent.click(screen.getByText("Later"));
    expect(sent).toContainEqual(["notifications:later", { key: "key.request:c:GITHUB_TOKEN" }]);
    fireEvent.click(await screen.findByText("Undo"));
    expect(sent).toContainEqual(["notifications:unlater", { key: "key.request:c:GITHUB_TOKEN" }]);
  });

  it("a Later item leaves the list and the count, and shows under Later", () => {
    const { container } = render(<><NeedsYou /><Pen /></>);
    set([n({ laterUntil: new Date(Date.now() + 3_600_000).toISOString() })]);
    expect(document.querySelector(".needs-you__hero")).toBeNull();
    expect(screen.getByText("Bring back now")).toBeTruthy();
    expect(container.querySelector(".rail-btn__count")).toBeNull();
  });

  it("a muted source leaves the list and shows one line with Unmute", () => {
    render(<NeedsYou />);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    set([n()], mergePrefs(DEFAULT_NOTICE_PREFS, { sources: { chats: { muteUntil: until } } }));
    expect(document.querySelector(".needs-you__hero")).toBeNull();
    fireEvent.click(screen.getByText("Unmute"));
    expect(sent).toContainEqual(["notifications:unmute", { sourceId: "chats" }]);
  });

  it("Urgent's menu has no Later or Mute", () => {
    render(<NeedsYou />);
    set([billing]);
    fireEvent.click(screen.getByLabelText("Options"));
    expect(screen.queryByText("Later")).toBeNull();
    expect(screen.getByText(/Always on/)).toBeTruthy();
  });
});
