import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  VersionHistory,
  formatVersionDate,
  versionLabel,
} from "../../../components/Documents/VersionHistory";

const now = new Date().toISOString();
const versions = [
  { versionId: "a_auto-save", timestamp: now, reason: "auto-save", named: false, preview: "x" },
  { versionId: "b_v2", timestamp: now, reason: "v2", named: true, preview: "y" },
  // older gateway: no `named` flag
  { versionId: "c_v1", timestamp: now, reason: "v1", preview: "z" },
];

describe("VersionHistory", () => {
  it("pins named versions above auto-saves", () => {
    render(
      <VersionHistory
        versions={versions}
        onGetVersion={vi.fn()}
        onRestore={vi.fn()}
        onSaveNamed={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const labels = Array.from(
      document.querySelectorAll(".version-history__item-reason"),
    ).map((n) => n.textContent);
    expect(labels).toEqual(["v2", "v1", "Auto-save"]);
    expect(screen.queryByText("Named")).not.toBeNull();
    expect(screen.queryByText("Auto-saves")).not.toBeNull();
  });

  it("saves a named version from the input", async () => {
    const onSaveNamed = vi.fn().mockResolvedValue(undefined);
    render(
      <VersionHistory
        versions={[]}
        onGetVersion={vi.fn()}
        onRestore={vi.fn()}
        onSaveNamed={onSaveNamed}
        onClose={vi.fn()}
      />,
    );
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/Name this version/), {
      target: { value: " v3 " },
    });
    fireEvent.click(save);
    await waitFor(() => expect(onSaveNamed).toHaveBeenCalledWith("v3"));
  });

  it("formats labels and dates", () => {
    expect(versionLabel("before-restore")).toBe("Before restore");
    expect(versionLabel("v2-after-review")).toBe("v2 after review");
    const ref = new Date("2026-10-30T12:00:00Z");
    expect(formatVersionDate("2026-10-30T11:30:00Z", ref)).toBe("30m ago");
    expect(formatVersionDate("2026-10-30T09:00:00Z", ref)).toBe("3h ago");
  });
});
