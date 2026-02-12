/**
 * Permission types for UI
 */

export type PermissionLevel = "open" | "moderate" | "strict";
export type KeyPermission = "ask" | "always";

export interface KeyPermissionRequest {
  keyName: string;
  description: string;
  isEnvKey: boolean;
  toolContext?: {
    toolName: string;
    command?: string;
  };
  requestId?: string; // Added by IPC layer
}

export interface KeyPermissionResponse {
  approved: boolean;
  alwaysAllow?: boolean;
}

export interface PermissionSettings {
  permissionLevel: PermissionLevel;
  requireConfirmForBash: boolean;
  requireConfirmForFileWrite: boolean;
  requireConfirmForBrowser: boolean;
}
