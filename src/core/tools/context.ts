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
}

const asyncLocalStorage = new AsyncLocalStorage<ToolContext>();

/**
 * Run a function within a tool context. Use this to wrap agent execution
 * so tools can access chatId via getCurrentChatId().
 */
export function runWithToolContext<T>(
  chatId: string,
  fn: () => T | Promise<T>,
  options?: { delegationJobId?: string },
): T | Promise<T> {
  return asyncLocalStorage.run(
    { chatId, delegationJobId: options?.delegationJobId },
    fn,
  );
}

/**
 * Set the current chatId for tool execution context.
 * Prefer runWithToolContext() for new code.
 */
export function setToolContext(
  chatId: string,
  options?: { delegationJobId?: string },
): void {
  asyncLocalStorage.enterWith({
    chatId,
    delegationJobId: options?.delegationJobId,
  });
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
