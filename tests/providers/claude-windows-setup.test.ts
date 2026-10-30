import { describe, expect, it } from "vitest";
import {
  buildPowerShellCommandLine,
  buildWindowsLauncherScript,
  psQuote,
  windowsClaudeExePath,
  withWindowsClaudeBinOnPath,
} from "../../src/core/services/claudeWindowsSetup.js";

const HOME = "C:\\Users\\Jane Doe";

describe("claude windows setup", () => {
  it("points at install.ps1's claude.exe location", () => {
    expect(windowsClaudeExePath(HOME)).toBe("C:\\Users\\Jane Doe\\.local\\bin\\claude.exe");
  });

  it("prepends the claude bin dir to PATH once", () => {
    const once = withWindowsClaudeBinOnPath("C:\\Windows;C:\\Windows\\System32", HOME);
    expect(once.split(";")[0]).toBe("C:\\Users\\Jane Doe\\.local\\bin");
    expect(withWindowsClaudeBinOnPath(once, HOME)).toBe(once);
  });

  it("builds PowerShell (not cmd.exe) command lines that survive spaces", () => {
    expect(psQuote("it's")).toBe("'it''s'");
    expect(
      buildPowerShellCommandLine({
        command: "C:\\Users\\Jane Doe\\.local\\bin\\claude.exe",
        args: ["setup-token"],
      }),
    ).toBe("& 'C:\\Users\\Jane Doe\\.local\\bin\\claude.exe' setup-token");
    const withEnv = buildPowerShellCommandLine({
      command: "C:\\Program Files\\Papr\\Papr.exe",
      args: ["C:\\x y\\cli.js", "setup-token"],
      extraEnv: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(withEnv).toBe(
      "$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files\\Papr\\Papr.exe' 'C:\\x y\\cli.js' setup-token",
    );
    expect(withEnv).not.toContain("&&");
    expect(withEnv).not.toMatch(/\bset "/);
  });

  it("launcher script puts claude.exe on PATH before running", () => {
    const script = buildWindowsLauncherScript({
      spec: { command: windowsClaudeExePath(HOME), args: ["setup-token"] },
      home: HOME,
      footer: "Copy the token, then paste it into Papr Work.",
    });
    const lines = script.split("\r\n");
    expect(lines[0]).toBe("$env:Path = 'C:\\Users\\Jane Doe\\.local\\bin' + ';' + $env:Path");
    expect(script).toContain("& 'C:\\Users\\Jane Doe\\.local\\bin\\claude.exe' setup-token");
    expect(script).not.toContain("GIT_BASH");
  });
});
