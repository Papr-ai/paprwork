import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SyncStatusPanel } from "../../components/Apps/SyncStatusPanel";
import type { SyncPanel } from "../../utils/syncPanelModel";

const noop = () => {};

describe("SyncStatusPanel", () => {
  it("empty: Nothing to send", () => {
    render(<SyncStatusPanel panel={{ header: { label: "Up to date", tone: "ok" }, rows: [], offerAgent: false }}
      onAction={noop} onApplyUpdate={noop} onAskAgentMergeAll={noop} />);
    expect(screen.getByText("Up to date")).toBeTruthy();
    expect(screen.getByText("Nothing to send")).toBeTruthy();
  });

  it("row action fires; Show all reveals files", () => {
    const onAction = vi.fn();
    const panel: SyncPanel = {
      header: { label: "Edits not published", tone: "warn" }, offerAgent: true,
      rows: [{ kind: "code", title: "Code", value: "1 app file", tone: "warn", action: { id: "publish", label: "Publish" },
        groups: [{ name: "App files", items: [{ path: "app.ts", change: "edited" }] }] }],
    };
    render(<SyncStatusPanel panel={panel} onAction={onAction} onApplyUpdate={noop} onAskAgentMergeAll={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(onAction).toHaveBeenCalledWith("publish");
    expect(screen.queryByText("app.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all 1" }));
    expect(screen.getByText("app.ts")).toBeTruthy();
  });

  it("conflicts: per-file choice is passed to Apply; merge-all lists files", () => {
    const onApply = vi.fn();
    const onAskAll = vi.fn();
    const panel: SyncPanel = {
      header: { label: "Update conflicts", tone: "bad" }, offerAgent: true,
      rows: [{ kind: "conflict", title: "2 files overlap your edits", value: "", tone: "bad",
        action: { id: "apply_update", label: "Apply update" },
        conflicts: [{ path: "app.ts" }, { path: "chart.ts" }] }],
    };
    render(<SyncStatusPanel panel={panel} onAction={noop} onApplyUpdate={onApply} onAskAgentMergeAll={onAskAll} />);
    fireEvent.click(screen.getAllByRole("radio", { name: "Theirs" })[0]);
    fireEvent.click(screen.getAllByRole("radio", { name: "Ask agent" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Apply update" }));
    expect(onApply).toHaveBeenCalledWith({ "app.ts": "theirs", "chart.ts": "agent" });
    fireEvent.click(screen.getByRole("button", { name: "Ask agent to merge all" }));
    expect(onAskAll).toHaveBeenCalledWith(["app.ts", "chart.ts"]);
  });
});
