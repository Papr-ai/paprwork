/**
 * Launch a hidden webview preview and collect console output for validate_app.
 */

import {
  formatRuntimeLogLine,
  getAppRuntimeLogService,
  normalizePreviewConsoleLevel,
  type AppRuntimeLogEntry,
} from "../services/AppRuntimeLogService.js";
import {
  analyzePreviewNetworkLogs,
  type PreviewNetworkProfile,
  type WebviewNetworkLogEntry,
} from "./miniAppPreviewNetworkProfile.js";
import { syncWebviewPreviewActivityLatch } from "../../core/tools/webviewSessionGuard.js";
import { checkPreviewDataRendered } from "./previewLoadedData.js";

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
  /** PNG data URL captured from the hidden preview window. */
  previewScreenshot?: string;
  /** DB/API request counts during preview window (Electron webview only). */
  networkProfile?: PreviewNetworkProfile;
  /** Rendered page (text + HTML) at snapshot time, for the data-rendered check. */
  renderedPage?: string;
  /** Epoch ms when the snapshot was taken. */
  snapshotAt?: number;
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

    const snapshotRes = await requestWebviewTest({
      action: "snapshot",
      payload: { webviewId, includeScreenshot: true },
    });
    const snapshotData =
      snapshotRes.success &&
      snapshotRes.data !== undefined &&
      snapshotRes.data !== null &&
      typeof snapshotRes.data === "object"
        ? (snapshotRes.data as { screenshot?: string; text?: string; html?: string })
        : undefined;
    const snapshotAt = Date.now();
    const renderedPage = snapshotData
      ? `${snapshotData.text ?? ""}\n${snapshotData.html ?? ""}`
      : undefined;
    const previewScreenshot =
      typeof snapshotData?.screenshot === "string"
        ? snapshotData.screenshot
        : undefined;

    const networkRes = await requestWebviewTest({
      action: "get_network",
      payload: { webviewId, limit: 200, clearAfterRead: true },
    });

    const networkData = networkRes.data;
    const networkLogs: WebviewNetworkLogEntry[] =
      networkRes.success &&
      networkData !== undefined &&
      networkData !== null &&
      typeof networkData === "object" &&
      "logs" in networkData &&
      Array.isArray((networkData as { logs: unknown }).logs)
        ? ((networkData as { logs: WebviewNetworkLogEntry[] }).logs ?? [])
        : [];
    const networkProfile = analyzePreviewNetworkLogs(networkLogs);

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
    await syncWebviewPreviewActivityLatch();

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
      previewScreenshot,
      networkProfile,
      renderedPage,
      snapshotAt,
    };
  } catch (error) {
    return {
      ...empty,
      skippedReason:
        error instanceof Error ? error.message : "runtime preview unavailable",
    };
  }
}

const isBackendEntry = (entry: AppRuntimeLogEntry): boolean =>
  (entry.source ?? "").startsWith("backend/");

/**
 * Recent iframe/preview errors. Backend action failures are excluded unless
 * they happened at or after `backendSinceIso` — an action that failed before the
 * agent fixed it must not fail the next validate_app.
 */
export function collectRecentRuntimeErrors(
  appId: string,
  sinceMs = 5 * 60 * 1000,
  backendSinceIso?: string,
): string[] {
  const backendCutoff = backendSinceIso ? Date.parse(backendSinceIso) : Infinity;
  return getAppRuntimeLogService()
    .getLogs(appId, { sinceMs, limit: 50, levels: ["error"] })
    .filter((e) => !isBackendEntry(e) || Date.parse(e.timestamp) >= backendCutoff)
    .map((e) => formatRuntimeLogLine(e));
}

export interface PostValidationRuntimeCheck {
  preview: MiniAppRuntimePreviewResult;
  iframeErrors: string[];
  allErrors: string[];
  loadWarnings: string[];
}

/** After esbuild validation passes: auto-launch preview + merge iframe error buffer. */
export async function runPostValidationRuntimeCheck(
  appId: string,
): Promise<PostValidationRuntimeCheck> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const preview = await runMiniAppRuntimePreview(appId);
  // Backend calls the preview made (POST /api/app/backend/*) log failures here.
  const iframeErrors = collectRecentRuntimeErrors(appId, undefined, startedAt);
  // Data the preview loaded that never reached the screen (calls succeeded, UI blank).
  const dataErrors =
    preview.renderedPage !== undefined && preview.snapshotAt !== undefined
      ? checkPreviewDataRendered(appId, startedMs, preview.snapshotAt, preview.renderedPage)
      : [];
  // Every backend action the preview did not call, once, read-only.
  const { probeBackendActions } = await import("./backendActionProbe.js");
  const { backendActionsCalledSince } = await import("./previewLoadedData.js");
  const probe = await probeBackendActions(appId, backendActionsCalledSince(appId, startedMs)).catch(
    (err: Error) => ({ errors: [`[backend] probe failed to run: ${err.message}`], probed: [], skipped: [] }),
  );
  const allErrors = [
    ...new Set([...preview.previewErrors, ...iframeErrors, ...dataErrors, ...probe.errors]),
  ];
  const loadWarnings = [
    ...(preview.networkProfile?.warnings ?? []),
    ...probe.skipped.map((s) => `[backend] not probed: "${s.action}" ${s.reason}`),
  ];
  return { preview, iframeErrors, allErrors, loadWarnings };
}
