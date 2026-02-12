/**
 * Permission Types
 * 
 * Types for the permission system that controls:
 * - Tool execution autonomy (permission level)
 * - API key usage permissions (per-key)
 */

/**
 * Global permission level for tool execution
 * 
 * - open: Tools run automatically without confirmation
 * - moderate: Some tools require confirmation
 * - strict: All tools require explicit confirmation
 */
export type PermissionLevel = "open" | "moderate" | "strict";

/**
 * Per-key permission for API key usage in tools
 * 
 * - ask: Prompt user each time key is used
 * - always: Auto-approve, never prompt
 */
export type KeyPermission = "ask" | "always";

/**
 * Permission request sent from main to renderer
 */
export interface KeyPermissionRequest {
  keyName: string;
  description: string;
  isEnvKey: boolean;
  toolContext?: {
    toolName: string;
    command?: string;
  };
}

/**
 * Permission response from renderer to main
 */
export interface KeyPermissionResponse {
  approved: boolean;
  alwaysAllow?: boolean; // Only for env keys
}

/**
 * Permission settings stored in settings.json
 */
export interface PermissionSettings {
  permissionLevel: PermissionLevel;
  requireConfirmForBash: boolean;
  requireConfirmForFileWrite: boolean;
  requireConfirmForBrowser: boolean;
}

/**
 * Default permission settings
 */
export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  permissionLevel: "open",
  requireConfirmForBash: false,
  requireConfirmForFileWrite: false,
  requireConfirmForBrowser: false,
};
