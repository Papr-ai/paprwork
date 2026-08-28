import { parseAppIdFromEditFilePath } from "./parseEditFileAppId";

const APP_EDIT_TOOL_NAMES = new Set([
  "edit_app_file",
  "edit_app_file_lines",
  "edit_file",
  "write_file",
  "update_app",
]);

const APP_CREATE_TOOL_NAMES = new Set(["create_app"]);

const APP_PREVIEW_TOOL_NAMES = new Set(["validate_app"]);

export function isAppEditToolName(toolName: string): boolean {
  return APP_EDIT_TOOL_NAMES.has(toolName);
}

export function isAppCreateToolName(toolName: string): boolean {
  return APP_CREATE_TOOL_NAMES.has(toolName);
}

export function isAppPreviewToolName(toolName: string): boolean {
  return APP_PREVIEW_TOOL_NAMES.has(toolName);
}

export function isAppAutoOpenToolName(toolName: string): boolean {
  return (
    isAppCreateToolName(toolName) ||
    isAppEditToolName(toolName) ||
    isAppPreviewToolName(toolName)
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Resolve mini-app id from tool args + result for merged-tab auto-open. */
export function resolveAppIdForAutoOpen(input: {
  toolName: string;
  args?: Record<string, unknown>;
  parsedResult?: Record<string, unknown> | null;
}): string | undefined {
  const { toolName, args, parsedResult } = input;
  const data =
    parsedResult && typeof parsedResult.data === "object" && parsedResult.data
      ? (parsedResult.data as Record<string, unknown>)
      : undefined;

  const fromArgsAppId = readString(args?.appId);
  if (fromArgsAppId) return fromArgsAppId;

  const fromResultAppId = readString(data?.appId) ?? readString(parsedResult?.appId);
  if (fromResultAppId) return fromResultAppId;

  const fromArgsPath = parseAppIdFromEditFilePath(args?.path);
  if (fromArgsPath) return fromArgsPath;

  const fromDataPath = parseAppIdFromEditFilePath(data?.path);
  if (fromDataPath) return fromDataPath;

  const fromResultPath = parseAppIdFromEditFilePath(parsedResult?.path);
  if (fromResultPath) return fromResultPath;

  if (toolName === "create_app") {
    return readString(data?.id) ?? readString(parsedResult?.id);
  }

  return undefined;
}

/** Whether auto-open should run after this tool result. */
export function shouldAutoOpenArtifactTab(input: {
  toolName: string;
  hasError: boolean;
  hasResult: boolean;
  parsedResult?: Record<string, unknown> | null;
  args?: Record<string, unknown>;
}): boolean {
  const { toolName, hasError, hasResult, parsedResult, args } = input;
  if (hasError || !hasResult) return false;

  if (toolName === "create_document" || toolName === "import_document") {
    return parsedResult?.success !== false;
  }

  if (!isAppAutoOpenToolName(toolName)) return false;

  const appId = resolveAppIdForAutoOpen({ toolName, args, parsedResult });
  if (!appId) return false;

  // Edits, create (artifact on disk), and validate_app — open even when validation failed.
  if (
    isAppEditToolName(toolName) ||
    toolName === "create_app" ||
    toolName === "validate_app"
  ) {
    return true;
  }

  // Headless preview launch — only when the tool reported success.
  return parsedResult?.success !== false;
}

export function isUserOnChatTab(
  chatTabId: string,
  activeTabId: string | null,
  getTab: (tabId: string) => { displayMode?: string; childTabIds?: string[]; parentTabId?: string | null } | undefined,
): boolean {
  if (!activeTabId) return false;

  const chatTab = getTab(chatTabId);
  const activeTab = getTab(activeTabId);

  return (
    activeTabId === chatTabId ||
    (chatTab?.displayMode === "parent" && activeTabId === chatTabId) ||
    (activeTab?.displayMode === "parent" &&
      (activeTab.childTabIds?.includes(chatTabId) ?? false)) ||
    (chatTab?.displayMode === "child" && chatTab.parentTabId === activeTabId)
  );
}
