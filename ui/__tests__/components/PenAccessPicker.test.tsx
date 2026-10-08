import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const updateKey = vi.fn(async () => true);
const key = { id: "k1", name: "MCP_LINEAR_OAUTH", vaultAudience: "user", penAccess: "full" as string | undefined };
vi.mock("../../hooks/useCustomKeys", () => ({
  useCustomKeys: () => ({ keys: [key], updateKey, getKeyValue: async () => "{}", loadKeys: async () => {} }),
}));
vi.mock("../../utils/vaultPullShared", () => ({ syncVaultKeyChange: async () => ({ success: true }) }));

import { PenAccessPicker } from "../../components/Settings/McpServerSheet";

const server = { id: "linear", name: "Linear" } as never;

describe("PenAccessPicker", () => {
  it("disables options above the org maximum and shows the capped level", () => {
    render(<PenAccessPicker server={server} orgMax="ask" />);
    expect(screen.getByRole("radio", { name: /Full access/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("radio", { name: /Ask before changes/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Not allowed by your org")).toBeTruthy();
  });

  it("saves the chosen level on the key", async () => {
    render(<PenAccessPicker server={server} />);
    fireEvent.click(screen.getByRole("radio", { name: /Read only/ }));
    await waitFor(() => expect(updateKey).toHaveBeenCalledWith("k1", expect.objectContaining({ penAccess: "read" })));
  });
});
