import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/gateway", () => ({ gateway: { send: vi.fn(() => Promise.resolve()), isConnected: () => false } }));
vi.mock("../stores/tabStore", () => ({ useTabStore: { getState: () => ({ tabs: [], createTab: vi.fn(), switchToTab: vi.fn() }) } }));
vi.mock("../stores/jobNavigationStore", () => ({ openJobInJobsTab: vi.fn() }));
vi.mock("../lib/ensureSettingsTab", () => ({ ensureSettingsTab: vi.fn() }));

import { openNoticeOwner, accountSection } from "../stores/noticeOs";
import { ensureSettingsTab } from "../lib/ensureSettingsTab";

describe("openNoticeOwner: account notices", () => {
  beforeEach(() => vi.mocked(ensureSettingsTab).mockClear());

  it("a member request from the cloud (no section) opens Billing, not Profile", () => {
    openNoticeOwner({ kind: "account", id: "billing", name: "Billing" }, "member.request:u1:seat");
    expect(ensureSettingsTab).toHaveBeenCalledWith({ section: "billing" });
  });

  it("a connection request from the cloud opens the Connections requests list", () => {
    expect(accountSection({ kind: "account", id: "connections", name: "Connections" }, "connection:r1")).toBe("connections-requests");
    openNoticeOwner({ kind: "account", id: "connections", name: "Connections" }, "connection:r1");
    expect(ensureSettingsTab).toHaveBeenCalledWith({ section: "connections" });
  });

  it("an explicit section still wins", () => {
    openNoticeOwner({ kind: "account", id: "billing", name: "Plan & usage", section: "connections" }, "account.credits");
    expect(ensureSettingsTab).toHaveBeenCalledWith({ section: "connections" });
  });

  it("an unknown account id opens Settings without a section", () => {
    expect(accountSection({ kind: "account", id: "network", name: "Network" })).toBeUndefined();
  });
});
