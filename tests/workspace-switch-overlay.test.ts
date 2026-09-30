import { describe, expect, it } from "vitest";
import {
  formatActiveWorkspaceLabel,
  formatWorkspaceSwitchTarget,
  parseWorkspaceSwitchLabels,
  workspaceSwitchPhaseLabel,
} from "../ui/lib/workspaceSwitchOverlay";

describe("workspaceSwitchOverlay", () => {
  it("parses organization and namespace labels from switch events", () => {
    expect(
      parseWorkspaceSwitchLabels({
        organizationName: "Revenue Reimagined",
        namespaceName: "Production",
      }),
    ).toEqual({
      organizationName: "Revenue Reimagined",
      namespaceName: "Production",
    });
  });

  it("formats target label for overlay", () => {
    expect(
      formatWorkspaceSwitchTarget({
        active: true,
        phase: "preparing",
        organizationName: "Acme",
        namespaceName: "Sandbox",
      }),
    ).toBe("Acme · Sandbox");
  });

  it("falls back to workspace name when org/namespace labels are missing", () => {
    expect(
      formatActiveWorkspaceLabel({
        workspaceName: "My Workspace",
      }),
    ).toBe("My Workspace");
  });

  it("maps gateway phases to user-facing copy", () => {
    expect(workspaceSwitchPhaseLabel("core")).toContain("agents");
    expect(workspaceSwitchPhaseLabel("services")).toContain("jobs");
  });
});
