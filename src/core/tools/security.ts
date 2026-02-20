/**
 * Tool Security Utilities
 *
 * Provides critical security features for tool execution:
 * - API key sanitization (prevent key leakage)
 * - Result truncation (prevent token overflow)
 * - Custom key substitution (enable ${VAR} in commands)
 */

/**
 * Maximum length for tool results before truncation
 * ~25K tokens at 4 chars/token
 */
export const MAX_TOOL_RESULT_LENGTH = 100000;

/**
 * Sanitize error messages and output to remove API keys
 *
 * CRITICAL SECURITY: Prevents API keys from appearing in:
 * - Error messages
 * - Bash output
 * - Tool results
 * - Console logs
 * - UI displays
 *
 * @param text - Text to sanitize
 * @param apiKeys - Array of API keys to remove
 * @returns Sanitized text with keys replaced by '***'
 *
 * @example
 * sanitizeError(
 *   "Error: Invalid key sk-abc123xyz",
 *   ["sk-abc123xyz"]
 * )
 * // Returns: "Error: Invalid key ***"
 */
export function sanitizeError(text: string, apiKeys: string[]): string {
  let sanitized = text;

  for (const key of apiKeys) {
    if (key && key.length > 0) {
      // Replace all occurrences (case-sensitive)
      const regex = new RegExp(escapeRegex(key), "g");
      sanitized = sanitized.replace(regex, "***");
    }
  }

  return sanitized;
}

/**
 * Truncate tool results to prevent token overflow
 *
 * Large outputs from tools like `npm install` or `git log`
 * can exceed context limits. This truncates safely.
 *
 * @param result - Result text to truncate
 * @param maxLength - Maximum length (default: 100K chars)
 * @returns Truncated result with info message
 *
 * @example
 * truncateResult("a".repeat(150000))
 * // Returns: "aaa...[50000 chars truncated]"
 */
export function truncateResult(
  result: string,
  maxLength: number = MAX_TOOL_RESULT_LENGTH,
): string {
  if (result.length <= maxLength) {
    return result;
  }

  const truncated = result.substring(0, maxLength);
  const remaining = result.length - maxLength;

  return `${truncated}\n\n[... ${remaining.toLocaleString()} characters truncated for brevity]`;
}

/**
 * Substitute custom API keys in bash commands
 *
 * Allows users to use placeholders like:
 * - ${OPENAI_API_KEY}
 * - ${ANTHROPIC_API_KEY}
 * - ${CUSTOM_TOKEN}
 *
 * These are replaced with actual values before execution.
 *
 * NOTE: This is the simple, synchronous version without permission checking.
 * For permission-aware substitution, use `substituteCustomKeysWithPermission`.
 *
 * @param command - Bash command with placeholders
 * @param customKeys - Map of key names to values
 * @returns Command with substituted values
 *
 * @example
 * substituteCustomKeys(
 *   'curl -H "Authorization: Bearer ${OPENAI_API_KEY}"',
 *   { OPENAI_API_KEY: 'sk-abc123' }
 * )
 * // Returns: 'curl -H "Authorization: Bearer sk-abc123"'
 */
export function substituteCustomKeys(
  command: string,
  customKeys: Record<string, string>,
): string {
  let result = command;

  for (const [name, value] of Object.entries(customKeys)) {
    if (value && value.length > 0) {
      // Match ${KEY_NAME} format
      const regex = new RegExp(`\\$\\{${escapeRegex(name)}\\}`, "g");
      result = result.replace(regex, value);
    }
  }

  return result;
}

/**
 * Permission request callback type
 * Used by permission-aware key substitution
 */
export type PermissionRequestCallback = (
  keyName: string,
  context: {
    toolName: string;
    command?: string;
  },
) => Promise<{ approved: boolean; alwaysAllow?: boolean }>;

/**
 * Substitute custom API keys with permission checking
 *
 * This version checks permissions before substituting keys.
 * If a key requires permission and callback is provided, it will:
 * 1. Check if key needs permission
 * 2. Call the permission request callback
 * 3. Throw error if denied
 * 4. Substitute the key if approved
 *
 * @param command - Bash command with placeholders
 * @param customKeys - Map of key names to values
 * @param context - Tool context (name, command)
 * @param onPermissionRequest - Callback for permission requests (optional)
 * @returns Promise<Command with substituted values>
 *
 * @example
 * const command = await substituteCustomKeysWithPermission(
 *   'curl -H "Authorization: Bearer ${OPENAI_API_KEY}"',
 *   { OPENAI_API_KEY: 'sk-abc123' },
 *   { toolName: 'bash', command: 'curl ...' },
 *   async (keyName, context) => {
 *     // Request permission from user
 *     return { approved: true, alwaysAllow: false };
 *   }
 * );
 */
export async function substituteCustomKeysWithPermission(
  command: string,
  customKeys: Record<string, string>,
  context: { toolName: string; command?: string },
  onPermissionRequest?: PermissionRequestCallback,
): Promise<string> {
  let result = command;

  // Find all keys used in the command
  const usedKeys: string[] = [];
  for (const name of Object.keys(customKeys)) {
    if (result.includes(`\${${name}}`)) {
      usedKeys.push(name);
    }
  }

  // Check permissions for each used key
  if (onPermissionRequest && usedKeys.length > 0) {
    for (const keyName of usedKeys) {
      try {
        const response = await onPermissionRequest(keyName, context);

        if (!response.approved) {
          throw new Error(
            `Permission denied for API key: ${keyName}\n` +
              `The key was needed for: ${context.toolName}\n` +
              `Command: ${context.command || "N/A"}`,
          );
        }

        // If approved, substitute the key
        const value = customKeys[keyName];
        if (value && value.length > 0) {
          const regex = new RegExp(`\\$\\{${escapeRegex(keyName)}\\}`, "g");
          result = result.replace(regex, value);
        }
      } catch (error) {
        // If permission request fails, re-throw with context
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(`Failed to request permission for key: ${keyName}`);
      }
    }
  } else {
    // No permission checking - substitute directly
    result = substituteCustomKeys(command, customKeys);
  }

  return result;
}

/**
 * Escape special regex characters
 * Helper for safe regex creation from user strings
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Get API keys from environment for sanitization
 * Collects all known API key patterns
 *
 * @returns Array of API keys to sanitize
 */
export function getApiKeysForSanitization(): string[] {
  const keys: string[] = [];

  // Common API key environment variables
  const keyVars = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "PAPR_API_KEY",
    "GOOGLE_API_KEY",
    "AZURE_API_KEY",
    "COHERE_API_KEY",
    "HUGGINGFACE_API_KEY",
    "REPLICATE_API_TOKEN",
  ];

  for (const varName of keyVars) {
    const value = process.env[varName];
    if (value && value.length > 0) {
      keys.push(value);
    }
  }

  return keys;
}

/**
 * Sanitize structured tool output
 * Applies sanitization to all string fields recursively
 *
 * @param data - Tool output data (object or primitive)
 * @param apiKeys - Array of API keys to remove
 * @returns Sanitized data
 */
export function sanitizeToolOutput(data: unknown, apiKeys: string[]): unknown {
  if (typeof data === "string") {
    return sanitizeError(data, apiKeys);
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeToolOutput(item, apiKeys));
  }

  if (data && typeof data === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      sanitized[key] = sanitizeToolOutput(value, apiKeys);
    }
    return sanitized;
  }

  return data;
}
