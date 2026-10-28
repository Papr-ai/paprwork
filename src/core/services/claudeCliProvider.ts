/**
 * Abstraction for Claude Code CLI resolution/installation.
 * Electron injects ClaudeCLIManager; core stays free of Electron imports.
 */

export interface ClaudeCliInstallProvider {
  ensureCLI(): Promise<string>;
  isAvailable(): Promise<boolean>;
  getVersion(): Promise<string | null>;
  /** Windows only: bash.exe Claude Code should use (CLAUDE_CODE_GIT_BASH_PATH). */
  getWindowsGitBashPath?(): Promise<string | null>;
}
