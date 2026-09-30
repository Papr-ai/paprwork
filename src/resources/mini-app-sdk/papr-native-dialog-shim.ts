/**
 * Auto-replace window.prompt/confirm/alert in embedded mini-apps.
 *
 * Cross-origin iframes (Paprwork local preview + Web toggle) silently block native
 * JS dialogs. This shim uses in-DOM papr-dialog UI instead.
 *
 * Sync callers (typical onclick handlers) are supported via a one-shot re-click:
 * first call returns false/null, dialog shows, user answers, the originating
 * click target is clicked again with the stored result.
 */

import { askConfirm, askText, showAlert } from "./papr-dialog.ts";

declare global {
  interface Window {
    __paprNativeDialogShimInstalled?: boolean;
    __paprConfirmReentry?: boolean;
    __paprPromptReentry?: string | null;
    __paprDialogClickTarget?: EventTarget | null;
  }
}

/** True when the app runs inside an iframe (native dialogs are unreliable). */
export function needsNativeDialogShim(): boolean {
  try {
    return window !== window.top;
  } catch {
    return true;
  }
}

function captureClickTarget(event: Event): void {
  if (event.isTrusted) {
    window.__paprDialogClickTarget = event.target;
  }
}

function reclickTargetIfNeeded(): void {
  const target = window.__paprDialogClickTarget;
  if (target instanceof HTMLElement) {
    target.click();
  }
}

function installConfirmShim(): void {
  window.confirm = (message?: string): boolean => {
    if (window.__paprConfirmReentry !== undefined) {
      const result = window.__paprConfirmReentry;
      window.__paprConfirmReentry = undefined;
      return result;
    }

    void askConfirm(String(message ?? "")).then((confirmed) => {
      window.__paprConfirmReentry = confirmed;
      if (confirmed) {
        reclickTargetIfNeeded();
      } else {
        window.__paprConfirmReentry = undefined;
      }
    });

    return false;
  };
}

function installPromptShim(): void {
  window.prompt = (
    message?: string,
    defaultValue?: string,
  ): string | null => {
    if (window.__paprPromptReentry !== undefined) {
      const result = window.__paprPromptReentry;
      window.__paprPromptReentry = undefined;
      return result;
    }

    void askText(
      String(message ?? ""),
      "",
      String(defaultValue ?? ""),
    ).then((value) => {
      if (value === "") {
        window.__paprPromptReentry = null;
        return;
      }
      window.__paprPromptReentry = value;
      reclickTargetIfNeeded();
    });

    return null;
  };
}

function installAlertShim(): void {
  window.alert = (message?: string): void => {
    void showAlert(String(message ?? ""));
  };
}

export function installNativeDialogShim(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  if (!needsNativeDialogShim()) {
    return;
  }
  if (window.__paprNativeDialogShimInstalled) {
    return;
  }
  window.__paprNativeDialogShimInstalled = true;

  document.addEventListener("click", captureClickTarget, true);
  installConfirmShim();
  installPromptShim();
  installAlertShim();
}

installNativeDialogShim();
