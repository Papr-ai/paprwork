import { describe, expect, it, vi } from "vitest";
import {
  ClaudeSetupTokenService,
  type ClaudeCliCheckResult,
} from "../src/core/services/ClaudeSetupTokenService.js";
import type { ClaudeCliInstallProvider } from "../src/core/services/claudeCliProvider.js";

type ServiceWithPathProbe = ClaudeSetupTokenService & {
  getClaudeCliCheckOnPath: () => Promise<ClaudeCliCheckResult>;
};

function mockNoGlobalClaude(service: ClaudeSetupTokenService): void {
  vi.spyOn(service as ServiceWithPathProbe, "getClaudeCliCheckOnPath").mockResolvedValue({
    installed: false,
  });
}

describe("ClaudeSetupTokenService on-demand CLI provider", () => {
  it("installClaudeCLI uses ensureCLI and never invokes npm", async () => {
    const ensureCLI = vi.fn(async () => "/tmp/claude-cli/package/cli.js");
    const isAvailable = vi.fn(async () => true);
    const getVersion = vi.fn(async () => "2.1.97 (Claude Code)");

    const provider: ClaudeCliInstallProvider = {
      ensureCLI,
      isAvailable,
      getVersion,
    };

    const service = new ClaudeSetupTokenService();
    service.setClaudeCliProvider(provider);
    mockNoGlobalClaude(service);

    const result = await service.installClaudeCLI();

    expect(result.success).toBe(true);
    expect(ensureCLI).toHaveBeenCalledTimes(1);
    expect(getVersion).toHaveBeenCalled();
  });

  it("getClaudeCliCheck reports installed when cached provider is available", async () => {
    const provider: ClaudeCliInstallProvider = {
      ensureCLI: vi.fn(async () => "/cache/cli.js"),
      isAvailable: vi.fn(async () => true),
      getVersion: vi.fn(async () => "2.1.97"),
    };

    const service = new ClaudeSetupTokenService();
    service.setClaudeCliProvider(provider);
    mockNoGlobalClaude(service);

    const check = await service.getClaudeCliCheck();
    expect(check.installed).toBe(true);
    expect(check.version).toBe("2.1.97");
  });

  it("writeSetupTokenLauncherScript includes setup-token and cached cli path", async () => {
    const cliPath = "/cache/claude-cli/package/cli.js";
    const provider: ClaudeCliInstallProvider = {
      ensureCLI: vi.fn(async () => cliPath),
      isAvailable: vi.fn(async () => true),
      getVersion: vi.fn(async () => null),
    };

    const service = new ClaudeSetupTokenService();
    service.setClaudeCliProvider(provider);
    mockNoGlobalClaude(service);

    const scriptPath = await service.writeSetupTokenLauncherScript();
    const fs = await import("fs/promises");
    const contents = await fs.readFile(scriptPath, "utf8");
    expect(contents).toContain("setup-token");
    expect(contents).toContain(cliPath);
  });

  it("getSetupTokenShellCommand quotes cached cli path", async () => {
    const cliPath = "/cache/claude-cli/package/cli.js";
    const provider: ClaudeCliInstallProvider = {
      ensureCLI: vi.fn(async () => cliPath),
      isAvailable: vi.fn(async () => true),
      getVersion: vi.fn(async () => null),
    };

    const service = new ClaudeSetupTokenService();
    service.setClaudeCliProvider(provider);
    mockNoGlobalClaude(service);

    const cmd = await service.getSetupTokenShellCommand();
    expect(cmd).toContain("setup-token");
    expect(cmd).toContain(cliPath);
    expect(cmd).not.toContain("npm");
  });
});
