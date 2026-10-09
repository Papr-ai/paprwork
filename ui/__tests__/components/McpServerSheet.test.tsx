import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const updateKey = vi.fn(async () => true);
let keyValue = "{\"tokens\":1}";
const getKeyValue = vi.fn(async () => keyValue);
const loadKeys = vi.fn(async () => {});
let keys: Array<Record<string, unknown>> = [];

vi.mock("../../hooks/useCustomKeys", () => ({
  useCustomKeys: () => ({ keys, updateKey, getKeyValue, loadKeys }),
}));
const syncVaultKeyChange = vi.fn(async () => ({ success: true }));
vi.mock("../../utils/vaultPullShared", () => ({ syncVaultKeyChange: (...a: unknown[]) => syncVaultKeyChange(...(a as [])) }));
vi.mock("../../components/Settings/IntegrationKeyMemberPicker", () => ({ IntegrationKeyMemberPicker: () => <div>members</div> }));
vi.mock("../../components/Settings/IntegrationKeyVaultAudienceSelector", () => ({
  IntegrationKeyVaultAudienceSelector: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <select aria-label="Who can use it" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="user">Only me</option>
      <option value="namespace">Team</option>
    </select>
  ),
}));

import { McpServerSheet, mcpKeyName } from "../../components/Settings/McpServerSheet";

const base = { id: "linear", name: "Linear", state: "connected", toolCount: 12, requiresClientId: false };

describe("McpServerSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    keys = [{ id: "k1", name: "MCP_LINEAR_OAUTH", vaultAudience: "user" }];
    keyValue = "{\"tokens\":1}";
  });

  it("names the key the same way as the gateway", () => {
    expect(mcpKeyName("google-drive")).toBe("MCP_GOOGLE_DRIVE_OAUTH");
  });

  it("saves a new audience through updateKey + vault sync, carrying the value", async () => {
    render(<McpServerSheet server={base} onClose={() => {}} onDisconnect={() => {}} />);
    fireEvent.change(screen.getByLabelText("Who can use it"), { target: { value: "namespace" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(syncVaultKeyChange).toHaveBeenCalled());
    expect(updateKey).toHaveBeenCalledWith("k1", expect.objectContaining({ vaultAudience: "namespace", value: "{\"tokens\":1}" }));
    expect(syncVaultKeyChange).toHaveBeenCalledWith(
      expect.objectContaining({ name: "MCP_LINEAR_OAUTH", previousAudience: "user", nextAudience: "namespace" }),
    );
  });

  it("does not let you re-share a teammate's sign-in", () => {
    keys = [{ id: "k1", name: "MCP_LINEAR_OAUTH", vaultOrigin: "shared" }];
    render(<McpServerSheet server={base} onClose={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByText(/Only they can change/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("needs-setup services offer Set up with Pen, which opens a titled chat that sends", () => {
    const seen: unknown[] = [];
    const h = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("papr-chat-open", h);
    render(
      <McpServerSheet
        server={{ ...base, id: "hubspot", name: "HubSpot", state: "disconnected", requiresClientId: true }}
        onClose={() => {}}
        onDisconnect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set up with Pen" }));
    window.removeEventListener("papr-chat-open", h);
    expect(seen[0]).toMatchObject({ send: true, title: "Set up HubSpot" });
    expect((seen[0] as { message: string }).message).toContain("https://apps.papr.ai/oauth/callback");
  });

  it("not connected yet: pick who can use it, then Connect sends that choice", async () => {
    const onConnect = vi.fn(async () => {});
    render(
      <McpServerSheet server={{ ...base, state: "disconnected", toolCount: 0 }} onClose={() => {}} onDisconnect={() => {}} onConnect={onConnect} />,
    );
    fireEvent.change(screen.getByLabelText("Who can use it"), { target: { value: "namespace" } });
    expect(screen.getByText(/Papr keeps it signed in/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith({ audience: "namespace" }));
  });

  it("server-managed sign-in: sharing is changed by reconnecting, not edited in place", async () => {
    keys = [{ id: "k1", name: "MCP_LINEAR_OAUTH", vaultAudience: "org" }];
    keyValue = JSON.stringify({ tokens: { access_token: "a" }, serverRefresh: true });
    const onDisconnect = vi.fn();
    render(<McpServerSheet server={base} onClose={() => {}} onDisconnect={onDisconnect} />);
    await waitFor(() => expect(screen.getByText(/keeps this sign-in on its servers/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect to change" }));
    expect(onDisconnect).toHaveBeenCalled();
  });
});
