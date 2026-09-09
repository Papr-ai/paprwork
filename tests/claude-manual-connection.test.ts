import { describe, expect, test } from "vitest";
import {
  buildClaudeManualAgentPrompt,
  getClaudeCliInstallCommand,
  getClaudeManualConnectionSteps,
  getTerminalLabel,
} from "../ui/constants/claudeManualConnection";

describe("claude manual connection", () => {
  test("windows install uses PowerShell HTTPS installer", () => {
    expect(getClaudeCliInstallCommand("windows")).toBe(
      "irm https://claude.ai/install.ps1 | iex",
    );
    expect(getTerminalLabel("windows")).toBe("PowerShell");
  });

  test("mac install uses curl bash installer", () => {
    expect(getClaudeCliInstallCommand("mac")).toBe(
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
    expect(getTerminalLabel("mac")).toBe("Terminal");
  });

  test("manual steps include install, verify, and setup-token", () => {
    const steps = getClaudeManualConnectionSteps("windows");
    expect(steps).toHaveLength(4);
    expect(steps[1]?.command).toContain("install.ps1");
    expect(steps[2]?.command).toBe("claude --version");
    expect(steps[3]?.command).toBe("claude setup-token");
  });

  test("agent prompt references platform install command", () => {
    const prompt = buildClaudeManualAgentPrompt("windows");
    expect(prompt).toContain("install.ps1");
    expect(prompt).toContain("claude setup-token");
    expect(prompt).toContain("sk-ant-oat01-");
  });
});
