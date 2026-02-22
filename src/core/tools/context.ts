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
}

const asyncLocalStorage = new AsyncLocalStorage<ToolContext>();

/**
 * Run a function within a tool context. Use this to wrap agent execution
 * so tools can access chatId via getCurrentChatId().
 */
export function runWithToolContext<T>(
  chatId: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return asyncLocalStorage.run({ chatId }, fn);
}

/**
 * Set the current chatId for tool execution context.
 * Prefer runWithToolContext() for new code.
 */
export function setToolContext(chatId: string): void {
  asyncLocalStorage.enterWith({ chatId });
}

/**
 * Get the current chatId from tool execution context
 */
export function getCurrentChatId(): string | null {
  const context = asyncLocalStorage.getStore();
  return context?.chatId ?? null;
}

/**
 * Clear tool execution context (no-op when using runWithToolContext)
 */
export function clearToolContext(): void {
  // Context is scoped to runWithToolContext - no explicit clear needed
}
