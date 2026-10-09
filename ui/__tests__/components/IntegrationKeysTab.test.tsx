import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

let keys: Array<Record<string, unknown>> = [];
vi.mock("../../hooks/useCustomKeys", () => ({
  useCustomKeys: () => ({ keys, vaultContext: { organizationId: "o1", workspaceName: "Papr" }, loading: false, loadKeys: async () => {} }),
}));
vi.mock("../../utils/vaultPullShared", () => ({ pullSharedVaultKeys: async () => {} }));
vi.mock("../../components/Settings/KeySheet", () => ({
  KeySheet: ({ keyItem }: { keyItem: { name: string } | null }) => <div>sheet:{keyItem?.name ?? "new"}</div>,
}));

import { IntegrationKeysTab } from "../../components/Settings/IntegrationKeysTab";

describe("IntegrationKeysTab (Connections → API keys)", () => {
  beforeEach(() => {
    keys = [
      { id: "1", name: "STRIPE_KEY", vaultAudience: "namespace" },
      { id: "2", name: "OPENAI_API_KEY" },
      { id: "3", name: "MCP_LINEAR_OAUTH" },
      { id: "4", name: "RESEND_KEY", vaultOrigin: "shared", sharedShareScope: "org" },
    ];
  });

  it("lists your own and shared keys as rows; hides AI provider keys and service sign-ins", async () => {
    render(<IntegrationKeysTab embedded />);
    await waitFor(() => expect(screen.getByText("STRIPE_KEY")).toBeTruthy());
    expect(screen.getByText("RESEND_KEY")).toBeTruthy();
    expect(screen.queryByText("OPENAI_API_KEY")).toBeNull();
    expect(screen.queryByText("MCP_LINEAR_OAUTH")).toBeNull();
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.getByText(/Shared by a teammate · Organization/)).toBeTruthy();
  });

  it("a row opens its panel; + Add API key opens a blank one", async () => {
    render(<IntegrationKeysTab embedded />);
    fireEvent.click(await screen.findByText("STRIPE_KEY"));
    expect(screen.getByText("sheet:STRIPE_KEY")).toBeTruthy();
  });

  it("+ Add API key opens a blank panel", async () => {
    render(<IntegrationKeysTab embedded />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Add API key" }));
    expect(screen.getByText("sheet:new")).toBeTruthy();
  });
});
