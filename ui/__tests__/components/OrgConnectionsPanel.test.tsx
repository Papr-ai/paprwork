import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../../stores/proposalNoticeListener", () => ({ CONNECTIONS_REQUESTS_EVENT: "papr:connections-show-requests" }));

import { OrgConnectionsPanel } from "../../components/Settings/OrgConnectionsPanel";
import { canConnect } from "../../hooks/useOrgConnections";

function makeOrg(over: Record<string, unknown> = {}) {
  return {
    policy: { mode: "approved", approved: ["linear"], maxShare: "org", maxPenAccess: "full", setupBy: "admins" },
    isAdmin: true,
    requests: [
      {
        id: "r1",
        serverId: "hubspot",
        serverName: "HubSpot",
        status: "pending",
        requesters: [
          { userId: "u1", note: "pipeline report", at: "" },
          { userId: "u2", at: "" },
        ],
      },
    ],
    error: null,
    refresh: vi.fn(),
    updatePolicy: vi.fn(async () => true),
    request: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    decide: vi.fn(async () => true),
    ...over,
  } as never;
}

describe("OrgConnectionsPanel", () => {
  it("is hidden for members", () => {
    const { container } = render(<OrgConnectionsPanel org={makeOrg({ isAdmin: false })} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists requests with who asked and approves", () => {
    const org = makeOrg();
    render(<OrgConnectionsPanel org={org} />);
    expect(screen.getByText("HubSpot")).toBeTruthy();
    expect(screen.getByText("Requested by 2 people")).toBeTruthy();
    expect(screen.getByText("pipeline report")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect((org as { decide: ReturnType<typeof vi.fn> }).decide).toHaveBeenCalledWith("r1", true);
  });

  it("declines with an optional reason", () => {
    const org = makeOrg();
    render(<OrgConnectionsPanel org={org} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.change(screen.getByPlaceholderText("Reason (optional)"), { target: { value: "Use Salesforce" } });
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect((org as { decide: ReturnType<typeof vi.fn> }).decide).toHaveBeenCalledWith("r1", false, "Use Salesforce");
  });

  it("changes a rule", () => {
    const org = makeOrg();
    render(<OrgConnectionsPanel org={org} />);
    fireEvent.click(screen.getByRole("radio", { name: "Ask first" }));
    expect((org as { updatePolicy: ReturnType<typeof vi.fn> }).updatePolicy).toHaveBeenCalledWith({ maxPenAccess: "ask" });
  });
});

describe("canConnect (UI)", () => {
  it("matches the gateway rule", () => {
    expect(canConnect(null, "x")).toBe(true);
    expect(canConnect({ mode: "approved", approved: ["linear"] } as never, "hubspot")).toBe(false);
  });
});
