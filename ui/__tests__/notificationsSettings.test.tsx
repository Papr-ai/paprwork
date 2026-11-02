/**
 * Settings → Notifications: an app that sends its first notification while the page is open gets its
 * row without reopening; a source page shows short chips (full sentence on hover) and a Sound switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_NOTICE_PREFS } from "../../src/core/notifications/prefs";
import { PAPR_SOURCES } from "../../src/core/notifications/sources";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/lib/gateway", () => ({ gateway: { send } }));
import { NotificationsTab } from "../components/Settings/NotificationsTab";

let apps: { id: string; name: string }[] = [];
let prefs = DEFAULT_NOTICE_PREFS;
const center = () => ({ success: true, data: { prefs, defaults: DEFAULT_NOTICE_PREFS, sources: PAPR_SOURCES, apps, recent: [] } });
const broadcast = (notices: unknown[]) => act(() => {
  window.dispatchEvent(new CustomEvent("gateway-broadcast", { detail: { type: "notifications:changed", data: { notices } } }));
});
const appNotice = (id: string, name: string) => ({ key: `app:${id}:t`, source: { type: "app", id, name }, owner: { kind: "app", id, name } });

afterEach(cleanup);

describe("NotificationsTab", () => {
  beforeEach(() => {
    apps = []; prefs = DEFAULT_NOTICE_PREFS; send.mockReset();
    send.mockImplementation(async (type: string, payload?: { prefs?: { sources?: Record<string, { sound?: boolean }> } }) => {
      if (type === "notifications:set-prefs") prefs = { ...prefs, sources: { ...prefs.sources, ...payload?.prefs?.sources } };
      return center();
    });
  });

  it("adds a new app's row live, and doesn't refetch for apps it already lists", async () => {
    render(<NotificationsTab />);
    await screen.findByText("Chats");
    apps = [{ id: "app:crm", name: "CRM" }];
    broadcast([appNotice("crm", "CRM")]);
    await screen.findByText("CRM");
    const calls = send.mock.calls.length;
    broadcast([appNotice("crm", "CRM")]);
    expect(send.mock.calls.length).toBe(calls);
  });

  it("source page: short chips with the full sentence as the label, and a Sound switch that saves", async () => {
    render(<NotificationsTab />);
    fireEvent.click(await screen.findByText("Chats"));
    const chip = screen.getByRole("button", { name: "Something you set up in a chat is waiting on you" });
    expect(chip.textContent).toBe("Jobs waiting");
    expect(screen.getByText("Desktop notifications")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Sound for Chats"));
    await waitFor(() => expect(send).toHaveBeenCalledWith("notifications:set-prefs", { prefs: { sources: { chats: { sound: false } } } }));
  });
});
