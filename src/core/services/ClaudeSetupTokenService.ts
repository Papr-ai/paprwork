/**
 * ClaudeSetupTokenService - Automate OAuth token generation via Claude CLI
 * This service wraps the `claude setup-token` command to generate OAuth tokens
 * without requiring users to manually run CLI commands
 */

import { spawn, exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Electron apps don't inherit the user's shell PATH, so npm/node/claude
// won't be found. Resolve the user's real PATH via their login shell.
function getShellEnv(): Record<string, string> {
  const home = process.env.HOME || process.env.USERPROFILE || "";

  // Skip shell env resolution on Windows - just use existing PATH
  if (process.platform === "win32") {
    return {
      ...process.env,
      PATH: process.env.PATH || "",
    } as Record<string, string>;
  }

  // Unix: Try to get the real PATH from the user's login shell
  let shellPath = "";
  try {
    const { execSync } = require("child_process");
    const shell = process.env.SHELL || "/bin/zsh";
    shellPath = execSync(`${shell} -ilc 'echo $PATH'`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    // Fallback to common paths
  }

  const fallbackPaths = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    `${home}/.volta/bin`,
    `${home}/.local/bin`,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];

  const pathValue = shellPath
    ? shellPath
    : [...fallbackPaths, process.env.PATH || ""].join(":");

  return {
    ...process.env,
    PATH: pathValue,
  } as Record<string, string>;
}

export interface TokenGenerationResult {
  success: boolean;
  token?: string;
  error?: string;
  requiresInstall?: boolean;
}

export class ClaudeSetupTokenService {
  /**
   * Check if Claude Code CLI is installed
   */
  async isClaudeCLIInstalled(): Promise<boolean> {
    try {
      const whichCmd = process.platform === "win32" ? "where claude" : "which claude";
      await execAsync(whichCmd, { env: getShellEnv() });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install Claude Code CLI globally
   */
  async installClaudeCLI(): Promise<{ success: boolean; error?: string }> {
    try {
      console.log("[ClaudeSetupToken] Installing Claude Code CLI...");

      // Install @anthropic-ai/claude-code globally
      const { stdout, stderr } = await execAsync(
        "npm install -g @anthropic-ai/claude-code",
        {
          timeout: 120000, // 2 minutes timeout
          env: getShellEnv(),
        },
      );

      console.log("[ClaudeSetupToken] Installation output:", stdout);

      if (stderr && !stderr.includes("npm warn")) {
        console.error("[ClaudeSetupToken] Installation stderr:", stderr);
      }

      // Verify installation
      const installed = await this.isClaudeCLIInstalled();
      if (!installed) {
        return {
          success: false,
          error: "Installation completed but CLI not found in PATH",
        };
      }

      console.log("[ClaudeSetupToken] Claude Code CLI installed successfully");
      return { success: true };
    } catch (error) {
      console.error("[ClaudeSetupToken] Failed to install CLI:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Generate OAuth token by running `claude setup-token`
   * This will open a browser for OAuth authentication
   * Returns the token when the process completes
   */
  async generateToken(): Promise<TokenGenerationResult> {
    try {
      const isInstalled = await this.isClaudeCLIInstalled();
      if (!isInstalled) {
        return {
          success: false,
          requiresInstall: true,
          error: "Claude Code CLI not installed. Install it first.",
        };
      }

      console.log("[ClaudeSetupToken] Running claude setup-token...");

      return new Promise((resolve) => {
        let resolved = false;
        const safeResolve = (result: TokenGenerationResult) => {
          if (resolved) return;
          resolved = true;
          resolve(result);
        };

        const child = spawn("claude", ["setup-token"], {
          shell: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: getShellEnv(),
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data: Buffer) => {
          const output = data.toString();
          stdout += output;
          console.log("[ClaudeSetupToken] stdout:", output);

          // Detect interactive code prompt — the CLI is waiting for user
          // input we can't provide from Electron. Fail fast.
          const stripped = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
          if (stripped.includes("Paste code here") || stripped.includes("paste code")) {
            console.log("[ClaudeSetupToken] CLI waiting for code input — killing (can't interact from Electron)");
            child.kill();
            safeResolve({
              success: false,
              error: "Browser sign-in didn't complete automatically. Use Manual Setup to paste your token.",
            });
          }
        });

        child.stderr.on("data", (data: Buffer) => {
          const output = data.toString();
          stderr += output;
          console.error("[ClaudeSetupToken] stderr:", output);
        });

        child.on("close", (code: number | null) => {
          console.log(`[ClaudeSetupToken] Process exited with code ${code}`);

          if (code === 0) {
            const token = this.extractTokenFromOutput(stdout + stderr);
            if (token) {
              console.log("[ClaudeSetupToken] Token extracted successfully");
              safeResolve({ success: true, token });
            } else {
              safeResolve({
                success: false,
                error: "Token generation completed but token not found in output. Use Manual Setup.",
              });
            }
          } else {
            safeResolve({
              success: false,
              error: `Command exited with code ${code}. Use Manual Setup to connect.`,
            });
          }
        });

        child.on("error", (error: Error) => {
          console.error("[ClaudeSetupToken] Process error:", error);
          safeResolve({ success: false, error: error.message });
        });

        // Reduced timeout: if browser auth worked, token appears in <30s.
        // If it didn't, no point waiting 5 minutes.
        setTimeout(() => {
          if (!child.killed) {
            console.log("[ClaudeSetupToken] Timeout (45s) — killing process");
            child.kill();
            safeResolve({
              success: false,
              error: "Sign-in timed out. Use Manual Setup to connect.",
            });
          }
        }, 45_000);
      });
    } catch (error) {
      console.error("[ClaudeSetupToken] Failed to generate token:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Extract OAuth token from CLI output
   * Token format: sk-ant-oat01-xxxxx...xxxxx (only chars: a-zA-Z0-9_-)
   * The token wraps across lines and the CLI outputs ANSI codes.
   * Strategy: strip ALL ANSI codes, split into lines, find the line with "sk-ant-oat",
   * then collect consecutive lines that contain only valid token chars [a-zA-Z0-9_-].
   */
  private extractTokenFromOutput(output: string): string | null {
    console.log("[ClaudeSetupToken] Extracting token from output...");

    // Aggressively strip ANSI escape sequences (SGR, OSC, cursor, charset, etc.)
    const cleaned = output
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")   // SGR and cursor sequences
      .replace(/\x1b\][^\x07]*\x07/g, "")       // OSC sequences
      .replace(/\x1b[()][A-Za-z]/g, "")          // Charset sequences
      .replace(/\x1b[><=]/g, "");                // Keypad/mode sequences

    const lines = cleaned.split(/\r?\n/);
    const tokenParts: string[] = [];
    let foundStart = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (foundStart) break;
        continue;
      }

      if (!foundStart && line.includes("sk-ant-oat")) {
        const idx = line.indexOf("sk-ant-oat");
        tokenParts.push(line.substring(idx));
        foundStart = true;
        console.log(`[ClaudeSetupToken] Found token start: "${line.substring(idx, idx + 30)}..."`);
      } else if (foundStart && /^[a-zA-Z0-9_-]+$/.test(line)) {
        tokenParts.push(line);
        console.log(`[ClaudeSetupToken] Found continuation line: "${line}"`);
      } else if (foundStart) {
        console.log(`[ClaudeSetupToken] Stopped at non-token line: "${line.substring(0, 40)}..."`);
        break;
      }
    }

    if (tokenParts.length === 0) {
      console.error("[ClaudeSetupToken] ✗ No 'sk-ant-oat' found in output");
      console.error("[ClaudeSetupToken] Output sample:", output.substring(0, 300));
      return null;
    }

    // Join parts and strip any remaining whitespace
    const token = tokenParts.join("").replace(/\s+/g, "");

    console.log(`[ClaudeSetupToken] Token: length=${token.length}, start=${token.substring(0, 25)}..., end=...${token.substring(Math.max(0, token.length - 10))}`);

    if (token.startsWith("sk-ant-oat") && token.length > 80) {
      console.log(`[ClaudeSetupToken] ✓ Complete token (${tokenParts.length} parts, ${token.length} chars)`);
      return token;
    }

    console.warn(`[ClaudeSetupToken] Token too short (${token.length} chars)`);
    return null;
  }

  /**
   * Get stored token location from Claude CLI
   * Useful for debugging and verification
   */
  async getStoredTokenPath(): Promise<string | null> {
    try {
      // Claude CLI stores tokens in ~/.claude.json
      const homeDir =
        process.env.HOME || process.env.USERPROFILE || "";
      return `${homeDir}/.claude.json`;
    } catch {
      return null;
    }
  }

  /**
   * Read token from Claude CLI's storage
   * This can be used as a fallback if extraction from stdout fails
   * Claude Code stores tokens in:
   * - macOS: Keychain under 'Claude Code-credentials'
   * - Windows: ~/.claude/.credentials.json or Windows Credential Manager
   * - Linux: ~/.claude/.credentials.json
   */
  async readTokenFromCLIStorage(): Promise<string | null> {
    try {
      // Try platform-specific credential storage first
      if (process.platform === "darwin") {
        // macOS: Try Keychain
        try {
          console.log("[ClaudeSetupToken] Trying to read from macOS Keychain...");
          const { exec: execCallback } = await import("child_process");
          const { promisify } = await import("util");
          const exec = promisify(execCallback);
          
          const { stdout } = await exec(
            "security find-generic-password -s 'Claude Code-credentials' -w",
            { timeout: 5000 }
          );
          
          const credentialsJson = stdout.trim();
          if (credentialsJson) {
            const credentials = JSON.parse(credentialsJson);
            const rawToken =
              credentials?.claudeAiOauth?.accessToken ||
              credentials?.accessToken;
            if (rawToken && typeof rawToken === 'string') {
              const token = rawToken.replace(/\s+/g, "");
              console.log("[ClaudeSetupToken] Found token in Keychain (length: " + token.length + ")");
              return token;
            }
          }
        } catch (keychainError) {
          console.log("[ClaudeSetupToken] Could not read from Keychain:", (keychainError as Error).message);
        }
      } else if (process.platform === "win32") {
        // Windows: Skip Credential Manager for now (complex), go straight to file
        console.log("[ClaudeSetupToken] Windows: Checking file-based storage...");
      }
      
      // Fall back to ~/.claude/.credentials.json (cross-platform)
      const fs = await import("fs/promises");
      const homeDir = process.env.HOME || process.env.USERPROFILE || "";
      const credPath = `${homeDir}/.claude/.credentials.json`;
      
      try {
        const content = await fs.readFile(credPath, "utf-8");
        const credentials = JSON.parse(content);
        
        if (credentials.accessToken) {
          console.log("[ClaudeSetupToken] Found token in ~/.claude/.credentials.json");
          return String(credentials.accessToken).replace(/\s+/g, "");
        }
      } catch (fileError) {
        console.log("[ClaudeSetupToken] Could not read from ~/.claude/.credentials.json:", (fileError as Error).message);
      }

      // Try ~/.claude.json as last resort
      const tokenPath = `${homeDir}/.claude.json`;
      try {
        const content = await fs.readFile(tokenPath, "utf-8");
        const config = JSON.parse(content);

        if (config.oauthAccount?.accessToken) {
          console.log("[ClaudeSetupToken] Found token in ~/.claude.json");
          return String(config.oauthAccount.accessToken).replace(/\s+/g, "");
        }

        if (config.accessToken) {
          return String(config.accessToken).replace(/\s+/g, "");
        }
      } catch (jsonError) {
        console.log("[ClaudeSetupToken] Could not read from ~/.claude.json:", (jsonError as Error).message);
      }

      return null;
    } catch (error) {
      console.error(
        "[ClaudeSetupToken] Failed to read from CLI storage:",
        error,
      );
      return null;
    }
  }

  /**
   * Complete automated flow: Install CLI (if needed) + Generate token
   * Tries Keychain first to avoid CLI version incompatibilities.
   */
  async automatedSetup(): Promise<TokenGenerationResult> {
    // Step 0: Try reading existing token from Keychain/storage first
    // This avoids running the CLI entirely (which can fail due to Node version mismatches)
    console.log("[ClaudeSetupToken] Checking for existing token in storage...");
    const existingToken = await this.readTokenFromCLIStorage();
    if (existingToken) {
      console.log("[ClaudeSetupToken] Found existing token — skipping CLI");
      return { success: true, token: existingToken };
    }

    // Step 1: Check if CLI is installed
    const isInstalled = await this.isClaudeCLIInstalled();

    if (!isInstalled) {
      console.log(
        "[ClaudeSetupToken] Claude CLI not found, installing...",
      );

      // Step 2: Install CLI
      const installResult = await this.installClaudeCLI();
      if (!installResult.success) {
        return {
          success: false,
          error: `Failed to install Claude CLI: ${installResult.error}`,
        };
      }
    }

    // Step 3: Generate token
    const tokenResult = await this.generateToken();

    // Step 4: If generation failed or no token extracted, try reading from
    // CLI storage — the browser auth may have completed even though the CLI
    // couldn't return the token (e.g. killed due to "Paste code" prompt).
    if (!tokenResult.token) {
      console.log(
        "[ClaudeSetupToken] Trying to read token from CLI storage as fallback...",
      );
      const storedToken = await this.readTokenFromCLIStorage();

      if (storedToken) {
        console.log("[ClaudeSetupToken] Found token in CLI storage after fallback");
        return {
          success: true,
          token: storedToken,
        };
      }
    }

    return tokenResult;
  }
}
