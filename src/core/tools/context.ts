/**
 * Tool Execution Context
 * 
 * Provides ambient context to tools (like chatId) without requiring
 * it as an explicit parameter in every tool call.
 */

// Global context store (thread-safe for Node.js single-threaded model)
let currentChatId: string | null = null;

/**
 * Set the current chatId for tool execution context
 */
export function setToolContext(chatId: string): void {
  currentChatId = chatId;
}

/**
 * Get the current chatId from tool execution context
 */
export function getCurrentChatId(): string | null {
  return currentChatId;
}

/**
 * Clear tool execution context
 */
export function clearToolContext(): void {
  currentChatId = null;
}
