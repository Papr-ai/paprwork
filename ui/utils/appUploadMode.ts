/**
 * Plain-language helpers for per-app cloud upload mode (non-technical UI).
 */

export type CloudUploadModePref = "auto" | "manual" | "inherit";

/** Whether this app auto-uploads, resolving inherit → global default. */
export function resolveEffectiveAutoUpload(
  uploadMode: CloudUploadModePref | undefined,
  globalAutoUploadEnabled: boolean,
): boolean {
  const mode = uploadMode ?? "inherit";
  if (mode === "auto") {
    return true;
  }
  if (mode === "manual") {
    return false;
  }
  return globalAutoUploadEnabled;
}

export function usesGlobalUploadDefault(
  uploadMode: CloudUploadModePref | undefined,
): boolean {
  return (uploadMode ?? "inherit") === "inherit";
}

export function uploadModeFromToggle(enabled: boolean): "auto" | "manual" {
  return enabled ? "auto" : "manual";
}

export function autoUploadToggleHint(enabled: boolean): string {
  if (enabled) {
    return "Your app and data sync to the web in the background.";
  }
  return "Changes stay on this computer until you click Publish changes — good for testing first.";
}

export const AUTO_UPLOAD_SECTION_TITLE = "When changes go to the web";
export const AUTO_UPLOAD_TOGGLE_LABEL = "Publish automatically";
export const AUTO_UPLOAD_GLOBAL_HINT =
  "Using your workspace default. Change for all apps in Settings → Cloud Sync.";
