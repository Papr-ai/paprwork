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
import { wrapUntrustedContent } from "./contentProvenance.js";
import { getShell, getShellCommand } from "../utils/platform.js";

/** Commands that fetch or produce external content - wrap stdout for prompt injection defense */
const CURL_WGET_REGEX = /\b(curl|wget)\b/i;
const PYTHON_REGEX = /\b(python3?)\b/i;

function shouldWrapBashOutput(command: string): "curl" | "python" | null {
  if (CURL_WGET_REGEX.test(command)) return "curl";
  if (PYTHON_REGEX.test(command)) return "python";
  return null;
}

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
    .record(z.string(), z.string())
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

/** Matches ~/Papr/apps/{appId}/{filename} or $HOME/Papr/apps/... or /path/Papr/apps/... */
const APP_PATH_REGEX =
  /Papr\/apps\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([^\s"'`;|&<>]+)/gi;

/** Write indicators: redirects, sed -i, tee, cp, mv */
const WRITE_INDICATORS = [
  />\s*\S|>>\s*\S/, // > file or >> file
  /sed\s+-i/, // sed -i (in-place edit)
  /\btee\b/, // tee
  /\bcp\s+/, // cp src dest
  /\bmv\s+/, // mv src dest
];

/**
 * Detect if a bash command modifies files in ~/Papr/apps/{appId}/.
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
 * Called when bash modifies files in ~/Papr/apps/.
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
 * Detects if command is a grep search in PAPR folders
 * Returns { pattern, path } if detected, null otherwise
 */
function detectPaprGrepCommand(command: string): { pattern: string; path: string } | null {
  // Match: grep [options] "pattern" path/to/PAPR/...
  // Also match: grep [options] pattern path/to/PAPR/... (without quotes)
  const grepRegex = /\bgrep\s+(?:-[a-zA-Z]+\s+)*["']?([^"'\s]+)["']?\s+(.+)/i;
  const match = command.match(grepRegex);
  
  if (!match) return null;
  
  const pattern = match[1];
  const path = match[2].trim();
  
  // Check if path contains PAPR/apps or PAPR/Jobs
  if (path.includes('Papr/apps') || path.includes('Papr/Jobs')) {
    return { pattern, path };
  }
  
  return null;
}

/**
 * Search PAPR Memory for code matching the pattern
 */
async function searchPaprMemoryForCode(pattern: string): Promise<string | null> {
  try {
    // Check if PAPR_API_KEY is available
    const { getApiKey } = await import("../../gateway/utils/keyResolver.js");
    const paprKey = await getApiKey('PAPR_API_KEY');
    
    if (!paprKey) {
      return null; // No PAPR key, skip memory search
    }
    
    // Import Papr client
    const { default: Papr } = await import('@papr/memory');
    const client = new Papr({ xAPIKey: paprKey });
    
    // Search for code
    const response = await client.memory.search({
      query: pattern,
      max_memories: 10,
      max_nodes: 10,
      enable_agentic_graph: true,
      rank_results: true,
      response_format: 'toon',
      metadata: {
        category: 'learning',
        customMetadata: {
          source: 'code_indexer'
        }
      }
    });
    
    // Format results - response.data.memories
    if (!response?.data?.memories || response.data.memories.length === 0) {
      return null;
    }
    
    let output = '=== Memory Search Results (Semantic) ===\n';
    output += `Found ${response.data.memories.length} relevant code files:\n\n`;
    
    for (const memory of response.data.memories) {
      const metadata = memory.customMetadata as Record<string, string> | undefined;
      const filePath = metadata?.file_path || 'unknown';
      const projectId = metadata?.project_id || 'unknown';
      const language = metadata?.language || 'unknown';
      
      output += `📄 ${filePath}\n`;
      output += `   Project: ${projectId}\n`;
      output += `   Language: ${language}\n`;
      output += `   Match: ${memory.content.substring(0, 200)}...\n\n`;
    }
    
    return output;
    
  } catch (error) {
    console.warn('[Bash Tool] Memory search failed:', error);
    return null; // Fail gracefully
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
    
    // Check if this is a grep command in PAPR folders
    const grepInfo = detectPaprGrepCommand(command);
    let memoryPromise: Promise<string | null> | null = null;
    
    if (grepInfo) {
      // Run memory search in parallel (don't await yet)
      memoryPromise = searchPaprMemoryForCode(grepInfo.pattern);
      console.log(`[Bash Tool] Detected grep in Papr folder, running parallel memory search for: "${grepInfo.pattern}"`);
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
        Object.keys(env).length > 0 
          ? { ...process.env, ...(env as Record<string, string>) } 
          : process.env,
      shell: getShell(),
    });
    
    // If we started a memory search, wait for it now
    let memoryResults: string | null = null;
    if (grepInfo && memoryPromise) {
      try {
        memoryResults = await memoryPromise;
        if (memoryResults) {
          console.log(`[Bash Tool] Memory search returned ${memoryResults.split('\n').length} lines`);
        }
      } catch (error) {
        console.warn('[Bash Tool] Memory search error:', error);
        // Continue without memory results
      }
    }

    const duration = Date.now() - startTime;

    // Sanitize output before returning (no truncation - prepareStep keeps last full)
    let sanitizedStdout = sanitizeError(stdout || "", apiKeys);
    const sanitizedStderr = sanitizeError(stderr || "", apiKeys);
    
    // Combine memory results with grep results if available
    if (memoryResults && sanitizedStdout) {
      sanitizedStdout = `${memoryResults}\n\n=== Grep Results (Exact Match) ===\n${sanitizedStdout}`;
    } else if (memoryResults) {
      sanitizedStdout = `${memoryResults}\n\n=== Grep Results ===\nNo exact matches found.\n`;
    }

    // Wrap stdout from curl/wget/python - external content may contain prompt injections
    const wrapSource = shouldWrapBashOutput(input.command);
    if (wrapSource && sanitizedStdout) {
      sanitizedStdout = wrapUntrustedContent(wrapSource, "", sanitizedStdout);
    }

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
        let errStdout = sanitizeError(execError.stdout || "", apiKeys);
        const wrapSource = shouldWrapBashOutput(input.command);
        if (wrapSource && errStdout) {
          errStdout = wrapUntrustedContent(wrapSource, "", errStdout);
        }
        return {
          success: false,
          error: sanitizedError,
          type: "timeout_error",
          data: {
            stdout: errStdout,
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
      let errStdout = sanitizeError(execError.stdout || "", apiKeys);
      const wrapSource = shouldWrapBashOutput(input.command);
      if (wrapSource && errStdout) {
        errStdout = wrapUntrustedContent(wrapSource, "", errStdout);
      }
      return {
        success: false,
        error: sanitizedError,
        type: "execution_error",
        data: {
          stdout: errStdout,
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

    const [shellPath, shellArgs] = getShellCommand(command);
    const proc = spawn(shellPath, shellArgs, {
      cwd: cwd || process.cwd(),
      env: env ? { ...process.env, ...(env as Record<string, string>) } : process.env,
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
      let sanitizedStdout = sanitizeError(stdoutData, apiKeys);
      const sanitizedStderr = sanitizeError(stderrData, apiKeys);
      const sanitizedCommand = sanitizeError(input.command, apiKeys);

      // Wrap stdout from curl/wget/python - external content may contain prompt injections
      const wrapSource = shouldWrapBashOutput(input.command);
      if (wrapSource && sanitizedStdout) {
        sanitizedStdout = wrapUntrustedContent(wrapSource, "", sanitizedStdout);
      }

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
      let sanitizedStdout = sanitizeError(stdoutData, apiKeys);
      const sanitizedStderr = sanitizeError(stderrData, apiKeys);
      const sanitizedCommand = sanitizeError(input.command, apiKeys);
      const sanitizedError = sanitizeError(error.message, apiKeys);

      const wrapSource = shouldWrapBashOutput(input.command);
      if (wrapSource && sanitizedStdout) {
        sanitizedStdout = wrapUntrustedContent(wrapSource, "", sanitizedStdout);
      }

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
