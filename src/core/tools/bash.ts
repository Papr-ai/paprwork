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

// Cache for custom keys to avoid loading on every bash call
let customKeysCache: Record<string, string> | null = null;
let customKeysCacheTime = 0;
const CACHE_TTL = 60000; // 60 seconds

async function getCustomKeys(): Promise<Record<string, string>> {
  const now = Date.now();
  
  // Return cached keys if still valid
  if (customKeysCache && (now - customKeysCacheTime) < CACHE_TTL) {
    return customKeysCache;
  }
  
  // Build fresh keys map
  const keys: Record<string, string> = {};
  
  try {
    const { getCustomKeysService } =
      await import("../../gateway/services/CustomKeysService.js");
    const service = getCustomKeysService();
    const storedKeys = await service.listKeys();

    // Fetch values for all stored keys
    for (const keyMeta of storedKeys) {
      const value = await service.getKeyByName(keyMeta.name);
      if (value) {
        keys[keyMeta.name] = value;
      }
    }
  } catch (error) {
    console.warn("[Bash Tool] Failed to load custom keys:", error);
  }
  
  // Update cache
  customKeysCache = keys;
  customKeysCacheTime = now;
  
  return keys;
}

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
        role: 'assistant',
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
 * Detect if a command is backgrounded (ends with &, nohup, or uses disown)
 */
function isBackgroundedCommand(command: string): boolean {
  const trimmed = command.trim();
  // Check for trailing &, nohup, or disown patterns
  return /&\s*$/.test(trimmed) || /\bnohup\b/.test(trimmed) || /\bdisown\b/.test(trimmed);
}

/**
 * Execute a backgrounded command using spawn with proper detachment
 */
async function executeBackgroundedCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  apiKeys: string[],
  originalCommand: string,
  startTime: number,
): Promise<ToolResult<BashOutput>> {
  return new Promise((resolve) => {
    const [shellPath, shellArgs] = getShellCommand(command);
    
    // Spawn detached with stdio ignored to prevent hanging on orphaned pipes
    const proc = spawn(shellPath, shellArgs, {
      cwd: cwd || process.cwd(),
      env: Object.keys(env).length > 0 ? { ...process.env, ...env } : process.env,
      detached: true,
      stdio: 'ignore', // Critical: don't inherit stdio pipes
    });

    // Unref so parent doesn't wait for child
    proc.unref();

    const duration = Date.now() - startTime;
    const pid = proc.pid;

    // Return immediately - the process is now fully detached
    resolve({
      success: true,
      data: {
        stdout: `Background process started (PID: ${pid})\nNote: Use Job system for monitoring long-running processes.`,
        stderr: '',
        exitCode: 0,
        command: sanitizeError(originalCommand, apiKeys),
        duration,
      },
    });
  });
}



const WRITE_KEYWORDS_RE = /(>|>>|tee\b|sed\s+-i|cat\s+>|patch\b|git\s+(commit|reset|checkout|merge|rebase|cherry-pick|apply|am|stash\s+pop|revert)|cp\b|mv\b|rm\b|mkdir\b|touch\b|npm\s+(install|i|ci|update)|yarn\s+(add|install|upgrade)|pnpm\s+(add|install|update)|pip\s+install|poetry\s+(add|install|update)|cargo\s+(add|install|update)|brew\s+(install|upgrade)|make\b)/i;

/**
 * Probe whether `cwd` is inside a git work tree, and if so capture a quick
 * fingerprint of dirty state. Cheap (~5-15ms when in a repo, ~1-2ms when not).
 */
async function gitFingerprint(cwd: string | undefined): Promise<string | null> {
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execA = promisify(exec);
    const opts = { cwd: cwd || process.cwd(), timeout: 1500 };

    try {
      await execA("git rev-parse --is-inside-work-tree", opts);
    } catch {
      return null;
    }
    // Single short status to capture all dirty/untracked state
    const { stdout } = await execA(
      "git status --porcelain --untracked-files=normal",
      opts,
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * After a bash command finishes, if the git fingerprint changed, emit a
 * marker the UI parses to render an expandable file-changed card.
 *
 * Only runs when:
 *   1. Command looks like it could write files (heuristic regex).
 *   2. cwd is inside a git work tree.
 *   3. Fingerprint changed between before/after.
 */
async function captureGitChangesIfChanged(
  command: string,
  cwd: string | undefined,
  beforeFingerprint: string | null,
): Promise<string> {
  if (beforeFingerprint === null) return ""; // not in a git repo
  if (!WRITE_KEYWORDS_RE.test(command)) return ""; // read-only command
  try {
    const after = await gitFingerprint(cwd);
    if (after === null || after === beforeFingerprint) return "";

    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execA = promisify(exec);
    const opts = { cwd: cwd || process.cwd(), timeout: 2500 };

    const { stdout: stat } = await execA("git diff HEAD --stat", opts).catch(() => ({
      stdout: "",
    }));
    let combinedStat = stat.trim();

    try {
      const { stdout: untracked } = await execA(
        "git ls-files --others --exclude-standard",
        opts,
      );
      const untrackedFiles = untracked
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (untrackedFiles.length > 0) {
        const lines = untrackedFiles.map((f) => ` ${f} | new file`);
        combinedStat = (combinedStat ? combinedStat + "\n" : "") + lines.join("\n");
      }
    } catch {
      // ignore
    }
    if (!combinedStat) return "";

    const { stdout: namesOut } = await execA(
      "git diff HEAD --name-only",
      opts,
    ).catch(() => ({ stdout: "" }));
    const files = namesOut.split("\n").map((s) => s.trim()).filter(Boolean);

    const payload = JSON.stringify({ stat: combinedStat, files });
    return `\n__GIT_CHANGES__:${payload}:__END__`;
  } catch {
    return "";
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

  // Capture git fingerprint BEFORE command runs (cheap; no-op outside repos)
  // Only when the command might write — saves the probe for read-only ops.
  let __gitBefore: string | null = null;
  if (WRITE_KEYWORDS_RE.test(command)) {
    __gitBefore = await gitFingerprint(cwd);
  }

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

    // Quick check: does the command even use custom keys?
    const hasKeyPattern = /\$\{[A-Z_]+\}/.test(command);
    
    // Build custom keys map only if needed
    const customKeys: Record<string, string> = {};

    if (hasKeyPattern) {
      // 1. Add keys from environment
      for (const key of apiKeys) {
        const keyName = Object.keys(process.env).find(
          (k) => process.env[k] === key,
        );
        if (keyName) {
          customKeys[keyName] = key;
        }
      }

      // 2. Add keys from CustomKeysStorage (cached)
      const storedKeys = await getCustomKeys();
      for (const [keyName, value] of Object.entries(storedKeys)) {
        customKeys[keyName] = value;
        // Add to apiKeys array for sanitization
        if (!apiKeys.includes(value)) {
          apiKeys.push(value);
        }
      }
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

    // Check if this is a backgrounded command
    if (isBackgroundedCommand(command)) {
      console.log('[Bash Tool] Detected backgrounded command, using detached spawn');
      return await executeBackgroundedCommand(
        command,
        cwd,
        env,
        apiKeys,
        input.command,
        startTime,
      );
    }

    // Execute with timeout and improved buffer
    // Use a race between execAsync and explicit SIGKILL timeout
    let childProcess: ReturnType<typeof exec> | null = null;
    const execPromise = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      childProcess = exec(command, {
        cwd: cwd || process.cwd(),
        timeout,
        maxBuffer: 100 * 1024 * 1024, // 100MB buffer (up from 10MB)
        env:
          Object.keys(env).length > 0 
            ? { ...process.env, ...(env as Record<string, string>) } 
            : process.env,
        shell: getShell(),
      }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout: stdout || '', stderr: stderr || '' });
        }
      });
    });

    // Explicit SIGKILL timeout handler (fallback if exec's timeout doesn't work)
    const killTimer = setTimeout(() => {
      if (childProcess && !childProcess.killed) {
        console.warn('[Bash Tool] Timeout exceeded, sending SIGKILL');
        childProcess.kill('SIGKILL');
      }
    }, timeout + 5000); // Give exec 5s grace period, then SIGKILL

    let stdout: string;
    let stderr: string;
    
    try {
      const result = await execPromise;
      stdout = result.stdout;
      stderr = result.stderr;
    } finally {
      clearTimeout(killTimer);
    }
    
    // Validate output exists (catch undefined/null from process failures)
    if (stdout === undefined && stderr === undefined) {
      console.warn('[Bash Tool] ⚠️ Command returned undefined output - possible process crash');
      return {
        success: false,
        error: 'Command returned no output (possible timeout or process failure)',
        type: 'execution_error',
        data: {
          stdout: '',
          stderr: 'No output captured from process',
          exitCode: -1,
          command: sanitizeError(command, apiKeys),
          duration: Date.now() - startTime,
        },
      };
    }
    
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

    // Tier 4: surface git changes (UI renders as expandable file-changed card).
    // Only fires when (1) cwd is a git repo, (2) command looked write-y,
    // (3) status fingerprint changed between before/after.
    try {
      const gitMarker = await captureGitChangesIfChanged(
        command,
        cwd,
        __gitBefore,
      );
      if (gitMarker) sanitizedStdout += gitMarker;
    } catch {
      // best-effort only
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
      if (execError.killed || execError.signal === "SIGTERM" || execError.signal === "SIGKILL") {
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

  // Quick check: does the command even use custom keys?
  const hasKeyPattern = /\$\{[A-Z_]+\}/.test(command);

  // Build custom keys map only if needed
  const customKeys: Record<string, string> = {};

  if (hasKeyPattern) {
    // 1. Add keys from environment
    for (const key of apiKeys) {
      const keyName = Object.keys(process.env).find(
        (k) => process.env[k] === key,
      );
      if (keyName) {
        customKeys[keyName] = key;
      }
    }

    // 2. Add keys from CustomKeysStorage (cached)
    const storedKeys = await getCustomKeys();
    for (const [keyName, value] of Object.entries(storedKeys)) {
      customKeys[keyName] = value;
      // Add to apiKeys array for sanitization
      if (!apiKeys.includes(value)) {
        apiKeys.push(value);
      }
    }
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
    let killTimer: NodeJS.Timeout | null = null;

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
      if (killTimer) clearTimeout(killTimer);
      
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
      if (killTimer) clearTimeout(killTimer);
      
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

    // Handle timeout - use SIGKILL to ensure process dies
    killTimer = setTimeout(() => {
      if (!proc.killed) {
        console.warn('[Bash Tool Streaming] Timeout exceeded, sending SIGKILL');
        proc.kill("SIGKILL");
      }
    }, timeout);
  });
}

/**
 * Tool definition for Mastra
 */
export const bashTool = createTool({
  id: "bash",
  description: `Execute bash commands on the system.

WHEN TO USE BASH TOOL:
✓ Short commands that complete in <60 seconds
✓ Commands with output <100MB
✓ One-off operations: file operations, git commands, package installs, quick scripts
✓ Commands where you need to see the full output immediately

WHEN TO USE JOB SYSTEM INSTEAD:
✗ Long-running processes (servers, training jobs, CI/CD pipelines)
✗ Commands that need monitoring or checkpointing
✗ Commands producing >100MB output or running >60 seconds
✗ Workflows requiring multiple coordinated long-running steps

BACKGROUNDED COMMANDS (ending with &, nohup, disown):
- Auto-detected and returned immediately with PID
- NO output captured (stdio fully detached)
- NO monitoring available after return
- Use ONLY for fire-and-forget tasks
- For monitored background work → use Job system

⚠️ PARALLEL EXECUTION WARNING:
When you make multiple bash calls in one response, they execute IN PARALLEL.
This can cause race conditions and jammed execution:
- DON'T: Make 5+ bash calls at once (causes confusion, delays, race conditions)
- DON'T: Use 'cd' to change directories (doesn't persist across parallel calls)
- DON'T: Have multiple calls modify the same file
- DO: Use 'cwd' parameter instead of 'cd' commands
- DO: Limit to 2-3 bash calls per response when possible
- DO: Use '&&' within a single bash command for sequential operations

Examples:
✅ GOOD: bash({ command: "npm install", cwd: "~/project" })
❌ BAD: bash({ command: "cd ~/project" }) then bash({ command: "npm install" })
✅ GOOD: bash({ command: "mkdir dir && cd dir && touch file.txt" })
❌ BAD: bash("mkdir dir"), bash("cd dir"), bash("touch file.txt") - parallel = broken

LIMITS:
- Timeout: 60 seconds (foreground commands only)
- Output buffer: 100MB
- Process killed with SIGKILL on timeout

Examples:
- Quick check: {"command": "git status"}
- Install deps: {"command": "npm install", "cwd": "/path/to/project"}
- Background task: {"command": "nohup python train.py > train.log 2>&1 &"} → returns immediately with PID, no output
- Long training (WRONG): {"command": "python train.py"} → will timeout at 60s, use Job instead
- Large output (WRONG): {"command": "grep -r pattern /"} → may exceed 100MB, use streaming or Job instead`,
  inputSchema: BashInputSchema,
  execute: executeBashCommand,
});
