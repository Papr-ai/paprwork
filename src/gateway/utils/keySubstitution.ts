/**
 * Key Substitution Utility for /api/bash/run
 *
 * Provides custom key substitution capability for mini-apps calling /api/bash/run.
 * Loads keys from CustomKeysService and substitutes ${KEY_NAME} placeholders.
 */

import { substituteCustomKeys } from "../../core/tools/security.js";

export interface KeySubstitutionResult {
  /** Command with keys substituted */
  command: string;
  /** API key values (for sanitization) */
  keyValues: string[];
  /** Names of keys that were used */
  usedKeyNames: string[];
}

/**
 * Load custom keys and substitute ${KEY_NAME} placeholders in command
 *
 * This combines:
 * 1. Loading keys from CustomKeysService (Keychain via IPC)
 * 2. Loading keys from environment variables
 * 3. Substituting ${KEY_NAME} in the command
 *
 * Used by /api/bash/run to give mini-apps access to custom keys.
 *
 * @param command - Bash command with ${KEY_NAME} placeholders
 * @returns Result with substituted command and key info for sanitization
 *
 * @example
 * const result = await substituteCustomKeysInCommand(
 *   'psql "${NEON_DB_URL}" -c "SELECT * FROM users"'
 * );
 * // result.command: 'psql "postgresql://..." -c "SELECT * FROM users"'
 * // result.keyValues: ["postgresql://..."]
 * // result.usedKeyNames: ["NEON_DB_URL"]
 */
export async function substituteCustomKeysInCommand(
  command: string,
): Promise<KeySubstitutionResult> {
  const customKeys: Record<string, string> = {};
  const keyValues: string[] = [];

  // 1. Add keys from environment (common API keys)
  const commonKeyVars = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "PAPR_API_KEY",
    "GOOGLE_API_KEY",
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "STRIPE_API_KEY",
    "NEON_DB_URL",
    "DATABASE_URL",
    "MYSQL_PASSWORD",
  ];

  for (const varName of commonKeyVars) {
    const value = process.env[varName];
    if (value) {
      customKeys[varName] = value;
      keyValues.push(value);
    }
  }

  // 2. Add keys from CustomKeysStorage (Settings → API Keys)
  try {
    const { getCustomKeysService } = await import(
      "../services/CustomKeysService.js"
    );
    const service = getCustomKeysService();
    const storedKeys = await service.listKeys();

    // Fetch values for all stored keys
    for (const keyMeta of storedKeys) {
      const value = await service.getKeyByName(keyMeta.name);
      if (value) {
        customKeys[keyMeta.name] = value;
        // Add to keyValues for sanitization (avoid duplicates)
        if (!keyValues.includes(value)) {
          keyValues.push(value);
        }
      }
    }
  } catch (error) {
    console.warn(
      "[KeySubstitution] Failed to load custom keys from storage:",
      error,
    );
    // Continue without custom keys - env vars still work
  }

  // 3. Determine which keys are actually used in the command
  const usedKeyNames: string[] = [];
  for (const keyName of Object.keys(customKeys)) {
    if (command.includes(`\${${keyName}}`)) {
      usedKeyNames.push(keyName);
    }
  }

  // 4. Substitute ${KEY_NAME} with actual values
  const substitutedCommand = substituteCustomKeys(command, customKeys);

  return {
    command: substitutedCommand,
    keyValues,
    usedKeyNames,
  };
}

/**
 * Check if command contains any ${KEY_NAME} placeholders
 *
 * @param command - Command to check
 * @returns True if command contains ${...} pattern
 */
export function commandUsesCustomKeys(command: string): boolean {
  return /\$\{[A-Z_][A-Z0-9_]*\}/i.test(command);
}
