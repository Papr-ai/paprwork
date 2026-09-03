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

import { spawn, type ChildProcess } from "child_process";
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
import {
  buildAppDbBashGuidance,
  formatAppDbGuidanceBlock,
} from "../utils/appDbGuidance.js";
import {
  buildSqlitePathWarnings,
  detectScratchDbWriteWhenRegistryExpected,
  formatSqlitePathWarningBlock,
} from "../utils/sqlitePathGuard.js";
import { getJobToolEnv } from "./context.js";

function mergeBashEnv(inputEnv?: Record<string, string>): Record<string, string> {
  return { ...getJobToolEnv(), ...(inputEnv ?? {}) };
}

function jobDbSchemaDdlBlockResult(
  command: string,
  env: Record<string, string>,
): ToolResult<BashOutput> | null {
  const mergedEnv = mergeBashEnv(env);

  const replicaBlock = detectReplicaRegistrySqliteBlock(command, {
    appDb:
      typeof mergedEnv.APP_DB === "string" ? mergedEnv.APP_DB : undefined,
    jobDb:
      typeof mergedEnv.JOB_DB === "string" ? mergedEnv.JOB_DB : undefined,
    env: mergedEnv,
  });
  if (replicaBlock) {
    return {
      success: false,
      error: replicaBlock.message,
      type: "validation_error",
      data: {
        stdout: "",
        stderr: replicaBlock.message,
        exitCode: 1,
        command,
        duration: 0,
        _schemaMigrationReminder: replicaBlock.message,
      },
    };
  }

  const scratchWriteBlock = detectScratchDbWriteWhenRegistryExpected(command, {
    appDb:
      typeof mergedEnv.APP_DB === "string" ? mergedEnv.APP_DB : undefined,
    jobDb:
      typeof mergedEnv.JOB_DB === "string" ? mergedEnv.JOB_DB : undefined,
    env: mergedEnv,
  });
  if (scratchWriteBlock) {
    return {
      success: false,
      error: scratchWriteBlock.message,
      type: "validation_error",
      data: {
        stdout: "",
        stderr: scratchWriteBlock.message,
        exitCode: 1,
        command,
        duration: 0,
        _schemaMigrationReminder: scratchWriteBlock.message,
      },
    };
  }

  const block = detectJobDbSchemaDdlBlock(command, {
    appDb:
      typeof mergedEnv.APP_DB === "string" ? mergedEnv.APP_DB : undefined,
    jobDb:
      typeof mergedEnv.JOB_DB === "string" ? mergedEnv.JOB_DB : undefined,
    env: mergedEnv,
  });
  if (!block) {
    return null;
  }
  return {
    success: false,
    error: block.message,
    type: "validation_error",
    data: {
      stdout: "",
      stderr: block.message,
      exitCode: 1,
      command,
      duration: 0,
      migrationPath: block.migrationPath,
      suggestedSql: block.suggestedSql,
      _schemaMigrationReminder: block.message,
    },
  };
}
import {
  isJobsIndexBashWriteBlocked,
  JOBS_INDEX_BASH_BLOCK_MESSAGE,
} from "../utils/jobsIndexBashGuard.js";
import { detectJobDbSchemaDdlBlock } from "../utils/jobDbSchemaGuard.js";
import { detectReplicaRegistrySqliteBlock } from "../utils/replicaBashSqliteGuard.js";
import {
  buildNamespaceGitTrapWarning,
  detectNamespaceGitTrapCommand,
} from "../utils/namespaceGitTrapGuard.js";
import { isPaprAppsOrJobsSearchPath } from "../utils/paprAgentPaths.js";
import { getShellCommand } from "../utils/platform.js";
import { classifyChildProcessError } from "../utils/childProcessErrors.js";
import { execShellCommand } from "../utils/shellExec.js";
import { SPAWN_STDIO_IGNORE_IN } from "../utils/spawnStdio.js";
import {
  detectPlatformBrowserBashTip,
  formatPlatformBrowserBashTip,
} from "../utils/platformBrowserBashGuard.js";

function destroyChildProcessStreams(proc: ChildProcess | null): void {
  if (!proc) return;
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  proc.stdin?.destroy();
}

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

export function invalidateCustomKeysCache(): void {
  customKeysCache = null;
  customKeysCacheTime = 0;
}

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
  /** Present when schema DDL is blocked on a synced database. */
  migrationPath?: string;
  suggestedSql?: string;
  _schemaMigrationReminder?: string;
  /** Actionable recovery hint when spawn fails (EBADF, EMFILE, fd pressure). */
  _processHint?: string;
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
  const grepPath = match[2].trim();

  if (isPaprAppsOrJobsSearchPath(grepPath)) {
    return { pattern, path: grepPath };
  }

  return null;
}

const PAPR_PROJECT_ID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Extract mini-app or job UUID from a Papr grep path, if present. */
export function extractProjectIdFromPaprPath(grepPath: string): string | undefined {
  const match = grepPath.match(PAPR_PROJECT_ID_REGEX);
  return match?.[0];
}

/**
 * Build the semantic query for automatic hybrid grep + code memory search.
 * Synthesized server-side from grep pattern and path — agent just passes grep.
 */
export function buildHybridMemorySearchQuery(
  pattern: string,
  grepPath: string,
): string {
  const scope =
    isPaprAppsOrJobsSearchPath(grepPath) &&
    /(?:Jobs|jobs)\//i.test(grepPath.replace(/\\/g, "/"))
      ? "jobs"
      : isPaprAppsOrJobsSearchPath(grepPath)
        ? "mini-apps"
        : "projects";
  const projectId = extractProjectIdFromPaprPath(grepPath);
  const projectClause = projectId ? ` Focus on project ${projectId}.` : "";

  return (
    `Find Papr ${scope} code related to "${pattern}".${projectClause} ` +
    "Include modules, handlers, and components that implement or reference this topic."
  );
}

/**
 * Search PAPR Memory for code matching the hybrid query (semantic, not literal grep pattern).
 */
async function searchPaprMemoryForCode(
  query: string,
  grepPath: string,
): Promise<string | null> {
  try {
    // Check if PAPR_API_KEY is available
    const { getApiKey } = await import("../../gateway/utils/keyResolver.js");
    const paprKey = await getApiKey('PAPR_API_KEY');
    
    if (!paprKey) {
      return null; // No PAPR key, skip memory search
    }
    
    // Import Papr client
    const { default: Papr } = await import('@papr/memory');
    const { buildSearchPolicy } = await import(
      "../../gateway/utils/paprMemoryPolicy.js"
    );
    const { PAPR_DEFAULT_HEADERS } = await import("./paprSurface.js");
    const client = new Papr({
      xAPIKey: paprKey,
      defaultHeaders: PAPR_DEFAULT_HEADERS,
    });

    const projectId = extractProjectIdFromPaprPath(grepPath);
    const customMetadata: Record<string, string> = {
      source: "code_indexer",
    };
    if (projectId) {
      customMetadata.project_id = projectId;
    }

    const response = await client.memory.search({
      query,
      max_memories: 10,
      max_nodes: 10,
      enable_agentic_graph: true,
      response_format: "toon",
      policy: buildSearchPolicy({ defaultDomain: "code" }),
      metadata: {
        role: "assistant",
        category: "learning",
        customMetadata,
      },
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
    const opts = { cwd: cwd || process.cwd(), timeout: 1500 };

    try {
      await execShellCommand("git rev-parse --is-inside-work-tree", opts);
    } catch {
      return null;
    }
    const { stdout } = await execShellCommand(
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

    const opts = { cwd: cwd || process.cwd(), timeout: 2500 };

    const { stdout: stat } = await execShellCommand("git diff HEAD --stat", opts).catch(() => ({
      stdout: "",
      stderr: "",
    }));
    let combinedStat = stat.trim();

    try {
      const { stdout: untracked } = await execShellCommand(
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

    const { stdout: namesOut } = await execShellCommand(
      "git diff HEAD --name-only",
      opts,
    ).catch(() => ({ stdout: "", stderr: "" }));
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
  const env = mergeBashEnv(input.env);

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

    if (isJobsIndexBashWriteBlocked(command)) {
      return {
        success: false,
        error: JOBS_INDEX_BASH_BLOCK_MESSAGE,
        type: "validation_error",
      };
    }

    const schemaDdlBlock = jobDbSchemaDdlBlockResult(command, env);
    if (schemaDdlBlock) {
      return schemaDdlBlock;
    }
    
    // Check if this is a grep command in PAPR folders
    const grepInfo = detectPaprGrepCommand(command);
    let memoryPromise: Promise<string | null> | null = null;
    
    if (grepInfo) {
      const memoryQuery = buildHybridMemorySearchQuery(
        grepInfo.pattern,
        grepInfo.path,
      );
      memoryPromise = searchPaprMemoryForCode(memoryQuery, grepInfo.path);
      console.log(
        `[Bash Tool] Detected grep in Papr folder, running parallel memory search: "${memoryQuery.substring(0, 120)}${memoryQuery.length > 120 ? "..." : ""}"`,
      );
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

    // Execute with timeout and improved buffer (stdin ignored — prevents EBADF)
    const mergedExecEnv: NodeJS.ProcessEnv =
      Object.keys(env).length > 0
        ? { ...process.env, ...(env as Record<string, string>) }
        : process.env;

    const { stdout, stderr } = await execShellCommand(command, {
      cwd: cwd || process.cwd(),
      timeout,
      maxBuffer: 100 * 1024 * 1024,
      env: mergedExecEnv,
    });
    
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

    // App file edits are picked up by AppService filesystem watchers (debounced rebuild + reload). (UI renders as expandable file-changed card).
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

    const mergedEnv: NodeJS.ProcessEnv =
      Object.keys(env).length > 0
        ? { ...process.env, ...(env as Record<string, string>) }
        : process.env;

    const sqliteWarnings = buildSqlitePathWarnings(command, {
      appDb:
        typeof mergedEnv.APP_DB === "string" ? mergedEnv.APP_DB : undefined,
      jobDb:
        typeof mergedEnv.JOB_DB === "string" ? mergedEnv.JOB_DB : undefined,
      env: mergedEnv,
    });
    if (sqliteWarnings.length > 0) {
      sanitizedStdout += formatSqlitePathWarningBlock(sqliteWarnings);
    }

    const appDbGuidance = buildAppDbBashGuidance(command);
    if (appDbGuidance) {
      sanitizedStdout += formatAppDbGuidanceBlock(appDbGuidance);
    }

    const oversizedWarning = await (async () => {
      const { formatOversizedAppFileWarningBlock } = await import(
        "../utils/oversizedAppFileWarnings.js"
      );
      return formatOversizedAppFileWarningBlock(input.command, cwd || process.cwd());
    })();
    if (oversizedWarning) {
      sanitizedStdout += oversizedWarning;
    }

    if (detectNamespaceGitTrapCommand(command)) {
      sanitizedStdout = buildNamespaceGitTrapWarning() + sanitizedStdout;
    }

    const platformBashTip = detectPlatformBrowserBashTip(command);
    if (platformBashTip) {
      sanitizedStdout += formatPlatformBrowserBashTip(platformBashTip);
    }

    void import("../../gateway/services/toolCapture/ToolCaptureService.js")
      .then(({ scheduleBashCapture }) =>
        scheduleBashCapture({
          originalCommand: input.command,
          stdout: sanitizedStdout,
        }),
      )
      .catch((error) => {
        console.warn(
          "[Bash Tool] Tool capture scheduling failed:",
          error instanceof Error ? error.message : String(error),
        );
      });

    return {
      success: true,
      data: {
        stdout: sanitizedStdout,
        stderr: sanitizedStderr,
        exitCode: 0,
        command: sanitizeError(command, apiKeys), // Sanitize command too
        duration,
        ...(sqliteWarnings.length > 0
          ? { _sqlitePathWarnings: sqliteWarnings }
          : {}),
        ...(oversizedWarning ? { _largeFileReminder: oversizedWarning.trim() } : {}),
      },
    };
  } catch (error: unknown) {
    const duration = Date.now() - startTime;
    const apiKeys = getApiKeysForSanitization();

    const classified = classifyChildProcessError(error, timeout);
    if (classified) {
      const execError = error as {
        stdout?: string;
        stderr?: string;
      };
      const sanitizedError = sanitizeError(classified.message, apiKeys);
      let errStdout = sanitizeError(execError.stdout || "", apiKeys);
      const wrapSource = shouldWrapBashOutput(input.command);
      if (wrapSource && errStdout) {
        errStdout = wrapUntrustedContent(wrapSource, "", errStdout);
      }
      return {
        success: false,
        error: sanitizedError,
        type: classified.type,
        data: {
          stdout: errStdout,
          stderr: sanitizeError(execError.stderr || "", apiKeys),
          exitCode: classified.exitCode,
          command: sanitizeError(input.command, apiKeys),
          duration,
          ...(classified.agentHint
            ? { _processHint: classified.agentHint }
            : {}),
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
  const env = mergeBashEnv(input.env);

  if (!command || command.trim().length === 0) {
    return {
      success: false,
      error: "Command cannot be empty",
      type: "validation_error",
    };
  }

  if (isJobsIndexBashWriteBlocked(command)) {
    return {
      success: false,
      error: JOBS_INDEX_BASH_BLOCK_MESSAGE,
      type: "validation_error",
    };
  }

  const schemaDdlBlock = jobDbSchemaDdlBlockResult(command, env);
  if (schemaDdlBlock) {
    return schemaDdlBlock;
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
      stdio: SPAWN_STDIO_IGNORE_IN,
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
      destroyChildProcessStreams(proc);

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
        // App file edits: AppService chokidar watcher handles debounced rebuild + reload.

        void import("../../gateway/services/toolCapture/ToolCaptureService.js")
          .then(({ scheduleBashCapture }) =>
            scheduleBashCapture({
              originalCommand: input.command,
              stdout: sanitizedStdout,
            }),
          )
          .catch((error) => {
            console.warn(
              "[Bash Tool] Tool capture scheduling failed:",
              error instanceof Error ? error.message : String(error),
            );
          });

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
      destroyChildProcessStreams(proc);

      const duration = Date.now() - startTime;
      let sanitizedStdout = sanitizeError(stdoutData, apiKeys);
      const sanitizedStderr = sanitizeError(stderrData, apiKeys);
      const sanitizedCommand = sanitizeError(input.command, apiKeys);
      const classified = classifyChildProcessError(error, timeout);
      const failure = classified ?? {
        type: "spawn_error" as const,
        message: `Could not start command — ${error.message}`,
        exitCode: -1,
      };
      const sanitizedError = sanitizeError(failure.message, apiKeys);

      const wrapSource = shouldWrapBashOutput(input.command);
      if (wrapSource && sanitizedStdout) {
        sanitizedStdout = wrapUntrustedContent(wrapSource, "", sanitizedStdout);
      }

      resolve({
        success: false,
        error: sanitizedError,
        type: failure.type,
        data: {
          stdout: sanitizedStdout,
          stderr: sanitizedStderr,
          exitCode: failure.exitCode,
          command: sanitizedCommand,
          duration,
          ...(failure.agentHint ? { _processHint: failure.agentHint } : {}),
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
✓ One-off operations: file operations, git commands, package installs, quick scripts, API probes (curl), sqlite peeks on job scratch DBs
✗ NEVER sqlite3/sqlite3.connect on a registry DB (data/databases/*/data.db) — even SELECT truncates the WAL and wedges cloud sync; blocked. Use query_cloud_turso / papr_db_sync_status, or sqlite3 "file:$PATH?mode=ro"
✓ Commands where you need to see the full output immediately
✓ Exploring data shape BEFORE committing to create_job — bash first, job only when reusable/scheduled/app-wired

WHEN TO USE JOB SYSTEM INSTEAD (create_job — not bash):
✓ User or mini-app will rerun this by name (button, schedule, pipeline)
✓ Linked to mini-app (appIds) and writes to $APP_DB
✓ Long-running processes (servers, training jobs, CI/CD pipelines)
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
