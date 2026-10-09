import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../../components/Settings/McpConnectionsTab", () => ({
  McpConnectionsTab: ({ embedded }: { embedded?: boolean }) => <div>mcp{embedded ? ":embedded" : ""}</div>,
}));
vi.mock("../../components/Settings/ConnectedPlatformsTab", () => ({
  ConnectedPlatformsTab: ({ embedded }: { embedded?: boolean }) => <div>platforms{embedded ? ":embedded" : ""}</div>,
}));
vi.mock("../../components/Settings/IntegrationKeysTab", () => ({
  IntegrationKeysTab: ({ embedded }: { embedded?: boolean }) => <div>keys{embedded ? ":embedded" : ""}</div>,
}));

vi.mock("../../hooks/useOrgConnections", () => ({
  useOrgConnections: () => ({ policy: null, isAdmin: false, requests: [] }),
}));
vi.mock("../../components/Settings/OrgConnectionsPanel", () => ({ OrgConnectionsPanel: () => null }));
vi.mock("../../stores/proposalNoticeListener", () => ({ CONNECTIONS_REQUESTS_EVENT: "papr:connections-show-requests" }));

import { ConnectionsView } from "../../components/Settings/ConnectionsView";

describe("ConnectionsView", () => {
  beforeEach(() => sessionStorage.clear());

  it("defaults to Services: MCP sign-ins plus browser sign-ins, both embedded", () => {
    render(<ConnectionsView />);
    expect(screen.getByRole("tab", { name: "Services" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("mcp:embedded")).toBeTruthy();
    expect(screen.getByText("platforms:embedded")).toBeTruthy();
    expect(screen.queryByText("keys:embedded")).toBeNull();
  });

  it("switches to API keys and remembers it", () => {
    const { unmount } = render(<ConnectionsView />);
    fireEvent.click(screen.getByRole("tab", { name: "API keys" }));
    expect(screen.getByText("keys:embedded")).toBeTruthy();
    unmount();
    render(<ConnectionsView />);
    expect(screen.getByText("keys:embedded")).toBeTruthy();
  });

  it("follows a deep link (legacy Key Vault tab id)", () => {
    const { rerender } = render(<ConnectionsView />);
    rerender(<ConnectionsView link={{ sub: "keys", n: 1 }} />);
    expect(screen.getByText("keys:embedded")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Services" }));
    rerender(<ConnectionsView link={{ sub: "keys", n: 2 }} />);
    expect(screen.getByText("keys:embedded")).toBeTruthy();
  });
});
