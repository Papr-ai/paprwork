/**
 * Windows-only helpers for getting Claude Code running for non-technical users.
 *
 * Anthropic's install.ps1 puts the native `claude.exe` in
 * %USERPROFILE%\.local\bin, which is not on Electron's PATH until the app
 * restarts. Current Claude Code (2.1.3xx) no longer requires Git for Windows:
 * without Git Bash it falls back to its PowerShell tool (verified on a clean
 * GitHub windows-latest runner; see .github/workflows/windows-claude-smoke.yml).
 *
 * Everything here is pure so it is testable on any OS.
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
  footer: string;
}): string {
  const lines = [
    `$env:Path = ${psQuote(windowsClaudeBinDir(opts.home))} + ';' + $env:Path`,
    `Write-Host 'Papr Work - Claude sign-in'`,
    `Write-Host ''`,
    buildPowerShellCommandLine(opts.spec),
    `Write-Host ''`,
    `Write-Host ${psQuote(opts.footer)}`,
  ];
  return lines.join("\r\n") + "\r\n";
}
