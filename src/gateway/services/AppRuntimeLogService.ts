/**
 * In-memory ring buffer for mini-app runtime console/error logs forwarded from
 * the desktop iframe (MiniAppView) and readable by validate_app / API.
 */

export type AppRuntimeLogLevel = "error" | "warn" | "info" | "log";

export interface AppRuntimeLogEntry {
  level: AppRuntimeLogLevel;
  message: string;
  source?: string;
  line?: number;
  column?: number;
  timestamp: string;
  /** iframe = user app tab; preview = webview_launch_app test window */
  origin: "iframe" | "preview";
}

const MAX_ENTRIES_PER_APP = 200;

export class AppRuntimeLogService {
  private readonly buffers = new Map<string, AppRuntimeLogEntry[]>();

  append(appId: string, entry: AppRuntimeLogEntry): void {
    const list = this.buffers.get(appId) ?? [];
    list.push(entry);
    if (list.length > MAX_ENTRIES_PER_APP) {
      list.splice(0, list.length - MAX_ENTRIES_PER_APP);
    }
    this.buffers.set(appId, list);
  }

  appendMany(appId: string, entries: AppRuntimeLogEntry[]): void {
    for (const entry of entries) {
      this.append(appId, entry);
    }
  }

  getLogs(
    appId: string,
    options: { limit?: number; sinceMs?: number; levels?: AppRuntimeLogLevel[] } = {},
  ): AppRuntimeLogEntry[] {
    const limit = options.limit ?? 100;
    const sinceMs = options.sinceMs;
    const levels = options.levels;
    let list = this.buffers.get(appId) ?? [];

    if (sinceMs !== undefined) {
      const cutoff = Date.now() - sinceMs;
      list = list.filter((entry) => new Date(entry.timestamp).getTime() >= cutoff);
    }
    if (levels !== undefined && levels.length > 0) {
      const allowed = new Set(levels);
      list = list.filter((entry) => allowed.has(entry.level));
    }

    return list.slice(-limit);
  }

  getErrorMessages(
    appId: string,
    options: { limit?: number; sinceMs?: number } = {},
  ): string[] {
    return this.getLogs(appId, {
      ...options,
      levels: ["error"],
    }).map((entry) => formatRuntimeLogLine(entry));
  }

  clear(appId: string): void {
    this.buffers.delete(appId);
  }
}

let singleton: AppRuntimeLogService | null = null;

export function getAppRuntimeLogService(): AppRuntimeLogService {
  if (!singleton) {
    singleton = new AppRuntimeLogService();
  }
  return singleton;
}

export function formatRuntimeLogLine(entry: AppRuntimeLogEntry): string {
  const loc =
    entry.source && entry.line !== undefined
      ? ` (${entry.source}:${entry.line})`
      : "";
  return `[${entry.origin}] ${entry.message}${loc}`;
}

/** Normalize Electron webview console level (0–3 number or string). */
export function normalizePreviewConsoleLevel(
  level: number | string,
): AppRuntimeLogLevel {
  if (typeof level === "number") {
    if (level >= 3) return "error";
    if (level === 2) return "warn";
    if (level === 1) return "info";
    return "log";
  }
  const lower = level.toLowerCase();
  if (lower === "error") return "error";
  if (lower === "warning" || lower === "warn") return "warn";
  if (lower === "info") return "info";
  return "log";
}
