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
      // Check if CLI is installed
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
        // Spawn the command with proper shell and stdio handling
        const process = spawn("claude", ["setup-token"], {
          shell: true,
          stdio: ["inherit", "pipe", "pipe"], // inherit stdin for interactive, pipe stdout/stderr
          env: getShellEnv(),
        });

        let stdout = "";
        let stderr = "";

        // Collect stdout
        process.stdout.on("data", (data: Buffer) => {
          const output = data.toString();
          stdout += output;
          console.log("[ClaudeSetupToken] stdout:", output);
        });

        // Collect stderr
        process.stderr.on("data", (data: Buffer) => {
          const output = data.toString();
          stderr += output;
          console.error("[ClaudeSetupToken] stderr:", output);
        });

        // Handle process completion
        process.on("close", (code: number) => {
          console.log(
            `[ClaudeSetupToken] Process exited with code ${code}`,
          );

          if (code === 0) {
            // Try to extract token from output
            const token = this.extractTokenFromOutput(stdout + stderr);

            if (token) {
              console.log("[ClaudeSetupToken] Token extracted successfully");
              resolve({
                success: true,
                token,
              });
            } else {
              console.error(
                "[ClaudeSetupToken] Token not found in output",
              );
              resolve({
                success: false,
                error:
                  "Token generation completed but token not found in output. Please try manual paste.",
              });
            }
          } else {
            resolve({
              success: false,
              error: `Command exited with code ${code}. Error: ${stderr}`,
            });
          }
        });

        // Handle process error
        process.on("error", (error: Error) => {
          console.error("[ClaudeSetupToken] Process error:", error);
          resolve({
            success: false,
            error: error.message,
          });
        });

        // Set timeout (5 minutes for user to complete OAuth)
        setTimeout(() => {
          if (!process.killed) {
            process.kill();
            resolve({
              success: false,
              error: "Token generation timed out after 5 minutes",
            });
          }
        }, 5 * 60 * 1000);
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
   * Token format: sk-ant-oat01-xxxxx...xxxxx
   * NOTE: Token may wrap across multiple lines in terminal output!
   */
  private extractTokenFromOutput(output: string): string | null {
    console.log("[ClaudeSetupToken] Extracting token from output...");
    
    // Line-by-line parsing (most reliable - avoids greedy regex issues)
    console.log("[ClaudeSetupToken] Using line-by-line parsing...");
    const lines = output.split(/\r?\n/);
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Found line with token start
      if (line.includes("sk-ant-oat")) {
        const startIdx = line.indexOf("sk-ant-oat");
        let token = line.substring(startIdx).trim();
        
        console.log(`[ClaudeSetupToken] Found token start at line ${i}: ${token.substring(0, 30)}...`);
        
        // Check next line(s) for continuation
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          const nextLine = lines[j].trim();
          
          // Stop at empty line or text that doesn't look like token
          if (!nextLine || 
              nextLine.startsWith("Store") || 
              nextLine.startsWith("Use") ||
              nextLine.startsWith("Paste") ||
              nextLine.toLowerCase().includes("secure") ||
              nextLine.toLowerCase().includes("export")) {
            break;
          }
          
          // Only append if line contains ONLY valid token characters
          if (/^[a-zA-Z0-9_-]+$/.test(nextLine)) {
            token += nextLine;
            console.log(`[ClaudeSetupToken] Appended continuation from line ${j}: ${nextLine}`);
          } else {
            break; // Stop if line has invalid chars
          }
        }
        
        // Validate token
        if (token.startsWith("sk-ant-oat") && token.length > 50) {
          console.log(`[ClaudeSetupToken] ✓ Found complete token (length: ${token.length})`);
          return token;
        } else {
          console.warn(`[ClaudeSetupToken] Token too short (${token.length} chars), expected >50`);
        }
      }
    }

    console.error("[ClaudeSetupToken] ✗ No valid token found in output");
    console.error("[ClaudeSetupToken] Output sample:", output.substring(0, 300));
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
            const token =
              credentials?.claudeAiOauth?.accessToken ||
              credentials?.accessToken;
            if (token && typeof token === 'string') {
              console.log("[ClaudeSetupToken] Found token in Keychain");
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
          return credentials.accessToken;
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
          return config.oauthAccount.accessToken;
        }

        if (config.accessToken) {
          return config.accessToken;
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

    // Step 4: If extraction failed, try reading from CLI storage
    if (tokenResult.success && !tokenResult.token) {
      console.log(
        "[ClaudeSetupToken] Trying to read token from CLI storage...",
      );
      const storedToken = await this.readTokenFromCLIStorage();

      if (storedToken) {
        return {
          success: true,
          token: storedToken,
        };
      }
    }

    return tokenResult;
  }
}
