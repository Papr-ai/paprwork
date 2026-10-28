import { describe, expect, it } from "vitest";
import {
  buildPowerShellCommandLine,
  buildWindowsLauncherScript,
  findWindowsGitBash,
  managedGitBashPath,
  psQuote,
  windowsClaudeExePath,
  withWindowsClaudeBinOnPath,
} from "../../src/core/services/claudeWindowsSetup.js";

const HOME = "C:\\Users\\Jane Doe";
const MANAGED = "C:\\Users\\Jane Doe\\AppData\\Roaming\\Papr Work\\git-portable";

describe("claude windows setup", () => {
  it("points at install.ps1's claude.exe location", () => {
    expect(windowsClaudeExePath(HOME)).toBe("C:\\Users\\Jane Doe\\.local\\bin\\claude.exe");
  });

  it("prepends the claude bin dir to PATH once", () => {
    const once = withWindowsClaudeBinOnPath("C:\\Windows;C:\\Windows\\System32", HOME);
    expect(once.split(";")[0]).toBe("C:\\Users\\Jane Doe\\.local\\bin");
    expect(withWindowsClaudeBinOnPath(once, HOME)).toBe(once);
  });

  it("prefers an existing Git for Windows over the managed copy", () => {
    const exists = (p: string) =>
      p === "C:\\Program Files\\Git\\bin\\bash.exe" || p === managedGitBashPath(MANAGED);
    expect(findWindowsGitBash({ env: {}, exists, managedGitDir: MANAGED })).toBe(
      "C:\\Program Files\\Git\\bin\\bash.exe",
    );
  });

  it("finds bash next to git on PATH and user-scope installs", () => {
    const gitOnPath = "D:\\Tools\\Git\\cmd\\git.exe";
    expect(
      findWindowsGitBash({
        env: {},
        exists: (p) => p === "D:\\Tools\\Git\\bin\\bash.exe",
        gitOnPath,
        managedGitDir: MANAGED,
      }),
    ).toBe("D:\\Tools\\Git\\bin\\bash.exe");
    const local = "C:\\Users\\Jane Doe\\AppData\\Local";
    expect(
      findWindowsGitBash({
        env: { LOCALAPPDATA: local },
        exists: (p) => p === `${local}\\Programs\\Git\\bin\\bash.exe`,
        managedGitDir: MANAGED,
      }),
    ).toBe(`${local}\\Programs\\Git\\bin\\bash.exe`);
  });

  it("falls back to managed PortableGit, else null (triggers download)", () => {
    const managed = managedGitBashPath(MANAGED);
    expect(
      findWindowsGitBash({ env: {}, exists: (p) => p === managed, managedGitDir: MANAGED }),
    ).toBe(managed);
    expect(findWindowsGitBash({ env: {}, exists: () => false, managedGitDir: MANAGED })).toBeNull();
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

  it("launcher script sets PATH and CLAUDE_CODE_GIT_BASH_PATH before running", () => {
    const script = buildWindowsLauncherScript({
      spec: { command: windowsClaudeExePath(HOME), args: ["setup-token"] },
      home: HOME,
      gitBashPath: managedGitBashPath(MANAGED),
      footer: "Copy the token, then paste it into Papr Work.",
    });
    const lines = script.split("\r\n");
    expect(lines[0]).toContain(".local\\bin");
    expect(lines[1]).toBe(
      `$env:CLAUDE_CODE_GIT_BASH_PATH = '${managedGitBashPath(MANAGED)}'`,
    );
    expect(script).toContain("& 'C:\\Users\\Jane Doe\\.local\\bin\\claude.exe' setup-token");
  });
});
