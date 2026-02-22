/**
 * Bash Tool - Command execution with security and timeout
 *
 * Executes bash commands with:
 * - Timeout enforcement (default 60s)
 * - Working directory control
 * - Environment variable isolation
 * - Output streaming support
 * - Error handling
 */

import { exec, spawn } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import type { ToolResult } from "../types/tools.js";
import {
  substituteCustomKeys,
  substituteCustomKeysWithPermission,
  sanitizeError,
  getApiKeysForSanitization,
} from "./security.js";

const execAsync = promisify(exec);

// Input schema - command required, others optional with smart defaults
const BashInputSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  cwd: z
    .string()
    .optional()
    .describe("Working directory (optional, defaults to current directory)"),
  timeout: z
    .number()
    .optional()
    .describe("Timeout in milliseconds (optional, defaults to 60000)"),
  env: z
    .record(z.string())
    .optional()
    .describe(
      "Environment variables (optional, defaults to system environment)",
    ),
});

export type BashInput = z.infer<typeof BashInputSchema>;

// Output type
export interface BashOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  duration: number;
}

/** Matches ~/PAPR/apps/{appId}/{filename} or $HOME/PAPR/apps/... or /path/PAPR/apps/... */
const APP_PATH_REGEX =
  /PAPR\/apps\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([^\s"'`;|&<>]+)/gi;

/** Write indicators: redirects, sed -i, tee, cp, mv */
const WRITE_INDICATORS = [
  />\s*\S|>>\s*\S/, // > file or >> file
  /sed\s+-i/, // sed -i (in-place edit)
  /\btee\b/, // tee
  /\bcp\s+/, // cp src dest
  /\bmv\s+/, // mv src dest
];

/**
 * Detect if a bash command modifies files in ~/PAPR/apps/{appId}/.
 * Returns [{ appId, filename }] for each app file that appears to be written.
 */
function detectAppFileEditsFromBashCommand(
  command: string,
): { appId: string; filename: string }[] {
  const hasWrite = WRITE_INDICATORS.some((re) => re.test(command));
  if (!hasWrite) return [];

  const matches: { appId: string; filename: string }[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(APP_PATH_REGEX.source, "gi");
  while ((m = re.exec(command)) !== null) {
    const appId = m[1];
    const filename = m[2].replace(/^["']|["']$/g, "").trim();
    if (!filename) continue;
    const key = `${appId}/${filename}`;
    if (!seen.has(key)) {
      seen.add(key);
      matches.push({ appId, filename });
    }
  }
  return matches;
}

/**
 * Broadcast app:file-changed for each edited app file (triggers iframe reload).
 * Called when bash modifies files in ~/PAPR/apps/.
 */
async function broadcastAppFileChanges(
  edits: { appId: string; filename: string }[],
): Promise<void> {
  if (edits.length === 0) return;
  try {
    const { broadcast } = await import("../../gateway/websocket/index.js");
    for (const { appId, filename } of edits) {
      broadcast({
        type: "app:file-changed",
        data: { appId, filename, timestamp: Date.now() },
      });
      console.log(
        `[Bash] Broadcasted app file change (bash edit): ${appId}/${filename}`,
      );
    }
  } catch (err) {
    console.warn("[Bash] Failed to broadcast app file changes:", err);
  }
}

/**
 * Execute bash command with timeout and safety
 */
export async function executeBashCommand(
  input: BashInput,
): Promise<ToolResult<BashOutput>> {
  const startTime = Date.now();

  // Apply defaults for optional parameters
  let { command } = input;
  const cwd = input.cwd || "";
  const timeout = input.timeout || 60000;
  const env = input.env || {};

  try {
    // Security: Basic validation
    if (!command || command.trim().length === 0) {
      return {
        success: false,
        error: "Command cannot be empty",
        type: "validation_error",
      };
    }

    // Get API keys for sanitization and substitution
    const apiKeys = getApiKeysForSanitization();

    // Build custom keys map from environment AND CustomKeysStorage
    const customKeys: Record<string, string> = {};

    // 1. Add keys from environment
    for (const key of apiKeys) {
      const keyName = Object.keys(process.env).find(
        (k) => process.env[k] === key,
      );
      if (keyName) {
        customKeys[keyName] = key;
      }
    }

    // 2. Add keys from CustomKeysStorage (user-configured keys)
    try {
      const { getCustomKeysService } =
        await import("../../gateway/services/CustomKeysService.js");
      const service = getCustomKeysService();
      const storedKeys = await service.listKeys();

      // Fetch values for all stored keys
      for (const keyMeta of storedKeys) {
        const value = await service.getKeyByName(keyMeta.name);
        if (value) {
          customKeys[keyMeta.name] = value;
          // Add to apiKeys array for sanitization
          if (!apiKeys.includes(value)) {
            apiKeys.push(value);
          }
        }
      }
    } catch (error) {
      console.warn("[Bash Tool] Failed to load custom keys:", error);
      // Continue without custom keys - env vars still work
    }

    // Check if command uses any keys - if so, request permission
    const usesKeys = Object.keys(customKeys).some((keyName) =>
      command.includes(`\${${keyName}}`),
    );

    if (usesKeys) {
      try {
        // Use permission-aware substitution
        // The global permission requester is set by Gateway
        const { requestKeyPermission } =
          await import("../../gateway/permissions/PermissionRequester.js");

        command = await substituteCustomKeysWithPermission(
          command,
          customKeys,
          { toolName: "bash", command: input.command },
          async (keyName, context) => {
            return await requestKeyPermission({
              keyName,
              description: `Allow ${keyName} to be used in bash command?`,
              isEnvKey: process.env[keyName] !== undefined,
              toolContext: context,
            });
          },
        );
      } catch (error) {
        // Permission denied or error requesting permission
        return {
          success: false,
          error: `Permission error: ${error instanceof Error ? error.message : String(error)}`,
          type: "permission_error",
        };
      }
    } else {
      // No keys used, simple substitution
      command = substituteCustomKeys(command, customKeys);
    }

    // Execute with timeout
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd || process.cwd(),
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      env:
        Object.keys(env).length > 0 ? { ...process.env, ...env } : process.env,
      shell: "/bin/bash",
    });

    const duration = Date.now() - startTime;

    // Sanitize output before returning (no truncation - prepareStep keeps last full)
    const sanitizedStdout = sanitizeError(stdout || "", apiKeys);
    const sanitizedStderr = sanitizeError(stderr || "", apiKeys);

    // If bash modified app files (e.g. sed, cat >, tee), broadcast so iframe reloads
    const appEdits = detectAppFileEditsFromBashCommand(input.command);
    if (appEdits.length > 0) {
      void broadcastAppFileChanges(appEdits);
    }

    return {
      success: true,
      data: {
        stdout: sanitizedStdout,
        stderr: sanitizedStderr,
        exitCode: 0,
        command: sanitizeError(command, apiKeys), // Sanitize command too
        duration,
      },
    };
  } catch (error: unknown) {
    const duration = Date.now() - startTime;
    const apiKeys = getApiKeysForSanitization();

    // Handle exec errors (non-zero exit codes)
    if (error && typeof error === "object" && "code" in error) {
      const execError = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        signal?: string;
      };

      // Timeout
      if (execError.killed || execError.signal === "SIGTERM") {
        const sanitizedError = sanitizeError(
          `Command timed out after ${timeout}ms`,
          apiKeys,
        );
        return {
          success: false,
          error: sanitizedError,
          type: "timeout_error",
          data: {
            stdout: sanitizeError(execError.stdout || "", apiKeys),
            stderr: sanitizeError(execError.stderr || "", apiKeys),
            exitCode: execError.code || -1,
            command: sanitizeError(input.command, apiKeys),
            duration,
          },
        };
      }

      // Non-zero exit code
      const sanitizedError = sanitizeError(
        `Command failed with exit code ${execError.code}`,
        apiKeys,
      );
      return {
        success: false,
        error: sanitizedError,
        type: "execution_error",
        data: {
          stdout: sanitizeError(execError.stdout || "", apiKeys),
          stderr: sanitizeError(execError.stderr || "", apiKeys),
          exitCode: execError.code || 1,
          command: sanitizeError(input.command, apiKeys),
          duration,
        },
      };
    }

    // Unknown error
    const message = error instanceof Error ? error.message : String(error);
    const sanitizedMessage = sanitizeError(message, apiKeys);
    return {
      success: false,
      error: `Bash execution failed: ${sanitizedMessage}`,
      type: "unknown_error",
    };
  }
}

/**
 * Execute bash command with streaming output
 * Useful for long-running commands
 */
export async function executeBashCommandStreaming(
  input: BashInput,
  onData: (type: "stdout" | "stderr", data: string) => void,
): Promise<ToolResult<BashOutput>> {
  const startTime = Date.now();

  // Apply defaults for optional parameters
  let command = input.command;
  const cwd = input.cwd || "";
  const timeout = input.timeout || 60000;
  const env = input.env || {};

  // Get API keys for sanitization and substitution
  const apiKeys = getApiKeysForSanitization();

  // Build custom keys map from environment AND CustomKeysStorage
  const customKeys: Record<string, string> = {};

  // 1. Add keys from environment
  for (const key of apiKeys) {
    const keyName = Object.keys(process.env).find(
      (k) => process.env[k] === key,
    );
    if (keyName) {
      customKeys[keyName] = key;
    }
  }

  // 2. Add keys from CustomKeysStorage (user-configured keys)
  try {
    const { getCustomKeysService } =
      await import("../../gateway/services/CustomKeysService.js");
    const service = getCustomKeysService();
    const storedKeys = await service.listKeys();

    // Fetch values for all stored keys
    for (const keyMeta of storedKeys) {
      const value = await service.getKeyByName(keyMeta.name);
      if (value) {
        customKeys[keyMeta.name] = value;
        // Add to apiKeys array for sanitization
        if (!apiKeys.includes(value)) {
          apiKeys.push(value);
        }
      }
    }
  } catch (error) {
    console.warn("[Bash Tool Streaming] Failed to load custom keys:", error);
    // Continue without custom keys - env vars still work
  }

  // Check if command uses any keys - if so, request permission
  const usesKeys = Object.keys(customKeys).some((keyName) =>
    command.includes(`\${${keyName}}`),
  );

  if (usesKeys) {
    try {
      // Use permission-aware substitution
      const { requestKeyPermission } =
        await import("../../gateway/permissions/PermissionRequester.js");

      command = await substituteCustomKeysWithPermission(
        command,
        customKeys,
        { toolName: "bash", command: input.command },
        async (keyName, context) => {
          return await requestKeyPermission({
            keyName,
            description: `Allow ${keyName} to be used in bash command?`,
            isEnvKey: process.env[keyName] !== undefined,
            toolContext: context,
          });
        },
      );
    } catch (error) {
      // Permission denied - return error immediately
      return {
        success: false,
        error: `Permission error: ${error instanceof Error ? error.message : String(error)}`,
        type: "permission_error",
      };
    }
  } else {
    // No keys used, simple substitution
    command = substituteCustomKeys(command, customKeys);
  }

  return new Promise((resolve) => {
    let stdoutData = "";
    let stderrData = "";

    const proc = spawn("/bin/bash", ["-c", command], {
      cwd: cwd || process.cwd(),
      env: env ? { ...process.env, ...env } : process.env,
      timeout,
    });

    // Stream stdout (sanitize before sending)
    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdoutData += text;
      const sanitized = sanitizeError(text, apiKeys);
      onData("stdout", sanitized);
    });

    // Stream stderr (sanitize before sending)
    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderrData += text;
      const sanitized = sanitizeError(text, apiKeys);
      onData("stderr", sanitized);
    });

    // Handle exit
    proc.on("close", (code: number | null) => {
      const duration = Date.now() - startTime;
      const exitCode = code ?? -1;

      // Sanitize final output (no truncation - prepareStep keeps last full)
      const sanitizedStdout = sanitizeError(stdoutData, apiKeys);
      const sanitizedStderr = sanitizeError(stderrData, apiKeys);
      const sanitizedCommand = sanitizeError(input.command, apiKeys);

      if (exitCode === 0) {
        // If bash modified app files, broadcast so iframe reloads
        const appEdits = detectAppFileEditsFromBashCommand(input.command);
        if (appEdits.length > 0) {
          void broadcastAppFileChanges(appEdits);
        }
        resolve({
          success: true,
          data: {
            stdout: sanitizedStdout,
            stderr: sanitizedStderr,
            exitCode,
            command: sanitizedCommand,
            duration,
          },
        });
      } else {
        resolve({
          success: false,
          error: sanitizeError(
            `Command failed with exit code ${exitCode}`,
            apiKeys,
          ),
          type: "execution_error",
          data: {
            stdout: sanitizedStdout,
            stderr: sanitizedStderr,
            exitCode,
            command: sanitizedCommand,
            duration,
          },
        });
      }
    });

    // Handle errors
    proc.on("error", (error: Error) => {
      const duration = Date.now() - startTime;
      const sanitizedStdout = sanitizeError(stdoutData, apiKeys);
      const sanitizedStderr = sanitizeError(stderrData, apiKeys);
      const sanitizedCommand = sanitizeError(input.command, apiKeys);
      const sanitizedError = sanitizeError(error.message, apiKeys);

      resolve({
        success: false,
        error: `Failed to execute: ${sanitizedError}`,
        type: "spawn_error",
        data: {
          stdout: sanitizedStdout,
          stderr: sanitizedStderr,
          exitCode: -1,
          command: sanitizedCommand,
          duration,
        },
      });
    });

    // Handle timeout
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
    }, timeout);
  });
}

/**
 * Tool definition for Mastra
 */
export const bashTool = createTool({
  id: "bash",
  description: `Execute bash commands on the system. Use for:
- Running scripts or command-line tools
- System operations (file operations, network requests)
- Package management (npm, pip, brew, etc.)
- Git operations
- Process management

IMPORTANT:
- Commands timeout after 60 seconds by default
- Use absolute paths or specify 'cwd' parameter
- For long operations, break into smaller commands
- Always check stdout/stderr in response

Examples:
- Run npm install: {"command": "npm install", "cwd": "/path/to/project", "timeout": 60000, "env": {}}
- Check git status: {"command": "git status", "cwd": "", "timeout": 60000, "env": {}}
- List files: {"command": "ls -la", "cwd": "", "timeout": 60000, "env": {}}`,
  inputSchema: BashInputSchema,
  execute: executeBashCommand,
});
