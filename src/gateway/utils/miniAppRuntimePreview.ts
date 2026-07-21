/**
 * Launch a hidden webview preview and collect console output for validate_app.
 */

import {
  getAppRuntimeLogService,
  normalizePreviewConsoleLevel,
  type AppRuntimeLogEntry,
} from "../services/AppRuntimeLogService.js";

export interface PreviewConsoleLog {
  level: number | string;
  message: string;
  line?: number;
  sourceId?: string;
  timestamp?: string;
}

export interface MiniAppRuntimePreviewResult {
  /** False when Gateway is not an Electron child (no webview IPC). */
  available: boolean;
  skippedReason?: string;
  webviewId?: string;
  loadStatus?: string;
  consoleLogs: PreviewConsoleLog[];
  /** Human-readable error lines from preview console (level error). */
  previewErrors: string[];
}

const PREVIEW_WAIT_MS = 2000;

function previewLogToEntry(log: PreviewConsoleLog): AppRuntimeLogEntry {
  const level = normalizePreviewConsoleLevel(log.level);
  return {
    level,
    message: log.message,
    source: log.sourceId,
    line: log.line,
    timestamp: log.timestamp ?? new Date().toISOString(),
    origin: "preview",
  };
}

export async function runMiniAppRuntimePreview(
  appId: string,
): Promise<MiniAppRuntimePreviewResult> {
  const empty: MiniAppRuntimePreviewResult = {
    available: false,
    consoleLogs: [],
    previewErrors: [],
  };

  try {
    const { requestWebviewTest } = await import("./webviewTestBridge.js");
    const launch = await requestWebviewTest({
      action: "launch",
      payload: { appId, visible: false, width: 1280, height: 720 },
    });

    if (!launch.success) {
      return {
        ...empty,
        skippedReason: launch.error ?? "webview launch failed",
      };
    }

    const launchData = launch.data as {
      webviewId?: string;
      status?: string;
    };
    const webviewId = launchData.webviewId;
    if (!webviewId) {
      return { ...empty, available: true, skippedReason: "missing webviewId" };
    }

    await new Promise((resolve) => setTimeout(resolve, PREVIEW_WAIT_MS));

    const consoleRes = await requestWebviewTest({
      action: "get_console",
      payload: { webviewId, limit: 100, clearAfterRead: true },
    });

    const data = consoleRes.data;
    const logs =
      consoleRes.success &&
      data !== undefined &&
      data !== null &&
      typeof data === "object" &&
      "logs" in data &&
      Array.isArray((data as { logs: unknown }).logs)
        ? ((data as { logs: PreviewConsoleLog[] }).logs ?? [])
        : [];

    const runtimeLogService = getAppRuntimeLogService();
    for (const log of logs) {
      runtimeLogService.append(appId, previewLogToEntry(log));
    }

    try {
      await requestWebviewTest({
        action: "close",
        payload: { webviewId },
      });
    } catch {
      // Non-fatal — preview session may already be closed
    }

    const previewErrors = logs
      .filter((log) => normalizePreviewConsoleLevel(log.level) === "error")
      .map((log) => {
        const loc =
          log.sourceId && log.line !== undefined
            ? ` (${log.sourceId}:${log.line})`
            : "";
        return `[preview] ${log.message}${loc}`;
      });

    return {
      available: true,
      webviewId,
      loadStatus: launchData.status,
      consoleLogs: logs,
      previewErrors,
    };
  } catch (error) {
    return {
      ...empty,
      skippedReason:
        error instanceof Error ? error.message : "runtime preview unavailable",
    };
  }
}

export function collectRecentRuntimeErrors(
  appId: string,
  sinceMs = 5 * 60 * 1000,
): string[] {
  return getAppRuntimeLogService().getErrorMessages(appId, { sinceMs, limit: 50 });
}

export interface PostValidationRuntimeCheck {
  preview: MiniAppRuntimePreviewResult;
  iframeErrors: string[];
  allErrors: string[];
}

/** After esbuild validation passes: auto-launch preview + merge iframe error buffer. */
export async function runPostValidationRuntimeCheck(
  appId: string,
): Promise<PostValidationRuntimeCheck> {
  const preview = await runMiniAppRuntimePreview(appId);
  const iframeErrors = collectRecentRuntimeErrors(appId);
  const allErrors = [...new Set([...preview.previewErrors, ...iframeErrors])];
  return { preview, iframeErrors, allErrors };
}
