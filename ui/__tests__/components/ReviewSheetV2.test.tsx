/**
 * Review sheet v2 (plan step 9): Checks, Try it, Ask Pen, destructive confirm.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../utils/cloudSyncAgentChat", () => ({ openCloudSyncAgentChat: vi.fn() }));
const resolveSpy = vi.fn(async () => undefined);
vi.mock("../../utils/cloudChangeRequestsApi", async (orig) => ({
  ...(await orig<typeof import("../../utils/cloudChangeRequestsApi")>()),
  resolveCloudChangeRequest: (...a: unknown[]) => resolveSpy(...(a as [])),
}));

import { CloudChangeRequestsPanel } from "../../components/Apps/CloudChangeRequestsPanel";
import type { CloudChangeRequest } from "../../utils/cloudChangeRequestsApi";

const req: CloudChangeRequest = {
  id: "r1", sourceAppId: "app", installedAppId: "copy", title: "Remove Notes", description: "Drops notes",
  status: "pending", headSha: "abc1234def", stagedPaths: ["tasks.ts"],
};

function mockChecks(body: unknown) {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as never;
}

afterEach(() => vi.restoreAllMocks());

describe("Review sheet v2", () => {
  const renderPanel = (onTry = vi.fn()) =>
    render(<CloudChangeRequestsPanel variant="modal" requests={[req]} pending={[req]} loading={false} error={null}
      onReload={async () => {}} checksAppId="app" onTry={onTry} />);

  it("shows plain Checks; Accept stays off until the delete is confirmed", async () => {
    mockChecks({
      checks: [{ tone: "bad", text: "Data change (notes): Removes the notes field from tasks." }],
      confirm: "I understand the notes in 42 tasks rows will be deleted for everyone",
      dataChange: true,
    });
    renderPanel();
    await screen.findByText(/Removes the notes field/);
    const accept = screen.getByRole("button", { name: "Accept and publish" }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/42 tasks rows will be deleted/));
    expect(accept.disabled).toBe(false);
    fireEvent.click(accept);
    await waitFor(() => expect(resolveSpy).toHaveBeenCalledWith("r1", "approve", { confirmDestructive: true }));
  });

  it("a safe change accepts in one click; Try it and Ask Pen are there", async () => {
    mockChecks({ checks: [{ tone: "ok", text: "No data change: only the app's code." }], confirm: null, dataChange: false });
    const onTry = vi.fn();
    renderPanel(onTry);
    await screen.findByText(/No data change/);
    expect((screen.getByRole("button", { name: "Accept and publish" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Ask Pen" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try it" }));
    expect(onTry).toHaveBeenCalledWith("r1");
  });
});
