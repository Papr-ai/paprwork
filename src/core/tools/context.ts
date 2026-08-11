/**
 * Tool Execution Context
 *
 * Provides ambient context to tools (like chatId) without requiring
 * it as an explicit parameter in every tool call.
 *
 * Uses AsyncLocalStorage to ensure context isolation between concurrent agent sessions.
 */

import { AsyncLocalStorage } from "async_hooks";

interface ToolContext {
  chatId: string;
  /** Set when a sub-agent job is executing tools (delegate_task job id). */
  delegationJobId?: string;
  /** Injected for agent jobs — APP_DB, PAPR_DB_*, JOB_DIR, etc. */
  jobEnv?: Record<string, string>;
}

const asyncLocalStorage = new AsyncLocalStorage<ToolContext>();

/**
 * Run a function within a tool context. Use this to wrap agent execution
 * so tools can access chatId via getCurrentChatId().
 */
export function runWithToolContext<T>(
  chatId: string,
  fn: () => T | Promise<T>,
  options?: { delegationJobId?: string; jobEnv?: Record<string, string> },
): T | Promise<T> {
  return asyncLocalStorage.run(
    {
      chatId,
      delegationJobId: options?.delegationJobId,
      jobEnv: options?.jobEnv,
    },
    fn,
  );
}

/**
 * Set the current chatId for tool execution context.
 * Prefer runWithToolContext() for new code.
 */
export function setToolContext(
  chatId: string,
  options?: { delegationJobId?: string; jobEnv?: Record<string, string> },
): void {
  asyncLocalStorage.enterWith({
    chatId,
    delegationJobId: options?.delegationJobId,
    jobEnv: options?.jobEnv,
  });
}

/** Job-scoped env vars (APP_DB, JOB_DIR, …) for agent job bash calls. */
export function getJobToolEnv(): Record<string, string> {
  const context = asyncLocalStorage.getStore();
  return context?.jobEnv ?? {};
}

const JOB_ENV_KEYS = [
  "PAPR_HOME",
  "JOB_DIR",
  "JOB_DB",
  "APP_DB",
  "APP_DB_ALIAS",
  "APP_DB_ID",
  "PAPR_WRITE_DB_IDS",
] as const;

/** Collect job-scoped env vars from process.env (cloud sandbox after prepareCloudJobEnvironment). */
export function collectJobEnvFromProcess(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of JOB_ENV_KEYS) {
    const value = env[key];
    if (value) {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("PAPR_DB_") && value) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Get the current chatId from tool execution context
 */
export function getCurrentChatId(): string | null {
  const context = asyncLocalStorage.getStore();
  return context?.chatId ?? null;
}

/**
 * Sub-agent delegation job id when tools run inside an isolated subagent job session.
 */
export function getCurrentDelegationJobId(): string | null {
  const context = asyncLocalStorage.getStore();
  return context?.delegationJobId ?? null;
}

/**
 * Clear tool execution context (no-op when using runWithToolContext)
 */
export function clearToolContext(): void {
  // Context is scoped to runWithToolContext - no explicit clear needed
}
