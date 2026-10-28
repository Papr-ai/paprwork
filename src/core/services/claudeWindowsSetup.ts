/**
 * Windows-only helpers for getting Claude Code running for non-technical users.
 *
 * Claude Code on Windows needs two things a fresh PC usually lacks:
 *   1. the native `claude.exe` (installed by Anthropic's install.ps1 into
 *      %USERPROFILE%\.local\bin — not on Electron's PATH until a restart), and
 *   2. Git Bash. Without it every command exits with "Claude Code on Windows
 *      requires git-bash". Claude looks in Program Files\Git, then next to
 *      `git` on PATH, then honours CLAUDE_CODE_GIT_BASH_PATH.
 *
 * Everything here is pure (paths and fs probes injected) so it is testable on
 * any OS. The Electron side (ClaudeCLIManager) does the downloading.
 */

import path from "path";

const win = path.win32;

/** Folder install.ps1 puts claude.exe in (`claude install` launcher dir). */
export function windowsClaudeBinDir(home: string): string {
  return win.join(home, ".local", "bin");
}

export function windowsClaudeExePath(home: string): string {
  return win.join(windowsClaudeBinDir(home), "claude.exe");
}

/** Prepend the Claude bin dir to a Windows PATH value (no duplicates). */
export function withWindowsClaudeBinOnPath(pathValue: string, home: string): string {
  const dir = windowsClaudeBinDir(home);
  const parts = pathValue.split(";").filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === dir.toLowerCase())) return pathValue;
  return [dir, ...parts].join(";");
}

/**
 * Pinned Git for Windows PortableGit. Self-extracting 7z, no admin, no
 * installer UI. SHA-256 from the official release notes — verified before
 * extraction. Bump both together.
 */
export const PORTABLE_GIT = {
  version: "2.56.0.windows.4",
  url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe",
  sha256: "b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1",
} as const;

export function managedGitBashPath(managedGitDir: string): string {
  return win.join(managedGitDir, "bin", "bash.exe");
}

export interface GitBashProbe {
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
  /** Absolute path of `git.exe` on PATH, if any. */
  gitOnPath?: string | null;
  managedGitDir: string;
}

/**
 * Same search order Claude Code uses, plus the user-scope Git install and
 * Papr's managed copy. Returns the bash.exe to use, or null if none.
 */
export function findWindowsGitBash(probe: GitBashProbe): string | null {
  const { env, exists } = probe;
  const explicit = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (explicit && exists(explicit)) return explicit;

  const candidates: string[] = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  if (env.LOCALAPPDATA) {
    candidates.push(win.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  if (probe.gitOnPath) {
    candidates.push(win.join(probe.gitOnPath, "..", "..", "bin", "bash.exe"));
  }
  candidates.push(managedGitBashPath(probe.managedGitDir));

  return candidates.find((c) => exists(c)) ?? null;
}

/** PowerShell single-quoted literal. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface WindowsClaudeCommand {
  command: string;
  args: string[];
  extraEnv?: Record<string, string>;
}

/** One-line PowerShell command a user can paste (shown in the UI). */
export function buildPowerShellCommandLine(spec: WindowsClaudeCommand): string {
  const env = Object.entries(spec.extraEnv ?? {})
    .map(([k, v]) => `$env:${k}=${psQuote(v)}; `)
    .join("");
  const cmd = spec.command === "claude" ? "claude" : `& ${psQuote(spec.command)}`;
  const args = spec.args.map((a) => (/^[\w-]+$/.test(a) ? a : psQuote(a))).join(" ");
  return `${env}${cmd} ${args}`.trim();
}

/**
 * .ps1 launcher opened in a real PowerShell window for `claude setup-token`.
 * Caller must write it with a UTF-8 BOM so Windows PowerShell 5.1 reads it.
 */
export function buildWindowsLauncherScript(opts: {
  spec: WindowsClaudeCommand;
  home: string;
  gitBashPath?: string | null;
  footer: string;
}): string {
  const lines = [
    `$env:Path = ${psQuote(windowsClaudeBinDir(opts.home))} + ';' + $env:Path`,
  ];
  if (opts.gitBashPath) {
    lines.push(`$env:CLAUDE_CODE_GIT_BASH_PATH = ${psQuote(opts.gitBashPath)}`);
  }
  lines.push(
    `Write-Host 'Papr Work - Claude sign-in'`,
    `Write-Host ''`,
    buildPowerShellCommandLine(opts.spec),
    `Write-Host ''`,
    `Write-Host ${psQuote(opts.footer)}`,
  );
  return lines.join("\r\n") + "\r\n";
}
