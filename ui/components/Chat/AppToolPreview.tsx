/**
 * Inline preview for validate / webview tools.
 * Shows live thumbnails from the agent's headless test browser while working,
 * then a screenshot gallery when each step completes.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { parseAppIdFromEditFilePath } from "../../utils/parseEditFileAppId";
import "./AppToolPreview.css";

interface AppToolPreviewProps {
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  status?: string;
}

interface ParsedToolResult {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

interface ValidationIssue {
  file?: string;
  line?: number;
  severity?: string;
  message?: string;
}

export function normalizeToolResult(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    try {
      return JSON.stringify(result);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseToolResult(result: unknown): ParsedToolResult | null {
  const normalized = normalizeToolResult(result);
  if (!normalized) return null;
  try {
    const parsed = JSON.parse(normalized) as ParsedToolResult;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function appIdFromGatewayUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const match = url.match(/\/apps\/([^/?#]+)/);
  return match?.[1];
}

function resolveAppId(
  toolName: string,
  args?: Record<string, unknown>,
  parsed?: ParsedToolResult | null,
): string | undefined {
  const data =
    parsed?.data && typeof parsed.data === "object"
      ? (parsed.data as Record<string, unknown>)
      : undefined;

  const fromArgs = readString(args?.appId);
  if (fromArgs) return fromArgs;

  const fromData = readString(data?.appId);
  if (fromData) return fromData;

  const fromSnapshotUrl = appIdFromGatewayUrl(readString(data?.url));
  if (fromSnapshotUrl) return fromSnapshotUrl;

  const fromPath =
    parseAppIdFromEditFilePath(args?.path) ??
    parseAppIdFromEditFilePath(data?.path);
  if (fromPath) return fromPath;

  if (toolName === "create_app") {
    return readString(data?.id);
  }

  return undefined;
}

function readWebviewId(
  args?: Record<string, unknown>,
  data?: Record<string, unknown>,
): string | undefined {
  return readString(args?.webviewId) ?? readString(data?.webviewId);
}

export function isWebviewSessionPreviewTool(
  toolName: string,
  args?: Record<string, unknown>,
): boolean {
  if (toolName === "page_wait_for") {
    return args?.target === "mini_app";
  }
  return (
    toolName === "webview_launch_app" ||
    toolName === "webview_wait_for" ||
    toolName === "webview_snapshot" ||
    toolName === "webview_fill_form" ||
    toolName === "webview_click"
  );
}

export interface WebviewSessionPreviewState {
  webviewId?: string;
  previewTarget?: "local" | "published";
  isActive: boolean;
  screenshots: string[];
  visibleText?: string;
  warnings: string[];
}

export function collectWebviewSessionPreview(
  toolCalls: Array<{
    toolName: string;
    args?: Record<string, unknown>;
    result?: unknown;
    status?: string;
  }>,
  isStreaming = false,
): WebviewSessionPreviewState | null {
  let webviewId: string | undefined;
  let previewTarget: "local" | "published" | undefined;
  let isAnyCalling = false;
  const screenshots: string[] = [];
  let visibleText: string | undefined;
  let warnings: string[] = [];
  let sawSessionTool = false;

  for (const toolCall of toolCalls) {
    if (!isWebviewSessionPreviewTool(toolCall.toolName, toolCall.args)) {
      continue;
    }
    sawSessionTool = true;
    if (toolCall.status === "calling") {
      isAnyCalling = true;
    }

    const parsed = parseToolResult(toolCall.result);
    const data =
      parsed?.data && typeof parsed.data === "object"
        ? (parsed.data as Record<string, unknown>)
        : undefined;

    if (toolCall.toolName === "webview_launch_app") {
      const target = toolCall.args?.previewTarget;
      if (target === "published" || target === "local") {
        previewTarget = target;
      }
      const launchTarget = readString(data?.previewTarget);
      if (launchTarget === "published" || launchTarget === "local") {
        previewTarget = launchTarget;
      }
    }

    const nextWebviewId = readWebviewId(toolCall.args, data);
    if (nextWebviewId) {
      webviewId = nextWebviewId;
    }

    for (const shot of extractFinalScreenshots(data)) {
      if (!screenshots.includes(shot)) {
        screenshots.push(shot);
      }
    }

    const text = readString(data?.text)?.slice(0, 600);
    if (text) {
      visibleText = text;
    }

    const visualState =
      data?.visualState && typeof data.visualState === "object"
        ? (data.visualState as Record<string, unknown>)
        : undefined;
    if (Array.isArray(visualState?.warnings)) {
      warnings = visualState.warnings as string[];
    }
  }

  if (!sawSessionTool) {
    return null;
  }

  return {
    webviewId,
    previewTarget,
    isActive: isAnyCalling || (isStreaming && screenshots.length === 0),
    screenshots,
    visibleText,
    warnings,
  };
}

export function shouldShowWebviewSessionPreview(
  state: WebviewSessionPreviewState | null,
): boolean {
  if (!state) {
    return false;
  }
  return (
    state.isActive ||
    state.screenshots.length > 0 ||
    Boolean(state.visibleText) ||
    state.warnings.length > 0 ||
    Boolean(state.webviewId)
  );
}

function extractFinalScreenshots(data?: Record<string, unknown>): string[] {
  const shots: string[] = [];
  const fromArray = data?.screenshots;
  if (Array.isArray(fromArray)) {
    for (const item of fromArray) {
      if (typeof item === "string" && item.length > 0) {
        shots.push(item);
      }
    }
  }
  const single =
    readString(data?.screenshot) ?? readString(data?.previewScreenshot);
  if (single && !shots.includes(single)) {
    shots.push(single);
  }
  return shots;
}

const PreviewHeader: React.FC<{
  label: string;
  meta?: string;
  expanded: boolean;
  onToggle: () => void;
}> = ({ label, meta, expanded, onToggle }) => (
  <div
    className="app-tool-preview-header"
    onMouseDown={(e) => {
      e.preventDefault();
      onToggle();
    }}
  >
    <span className={`app-tool-preview-chevron ${expanded ? "" : "collapsed"}`}>
      ▼
    </span>
    <span className="app-tool-preview-label">{label}</span>
    {meta && <span className="app-tool-preview-meta">{meta}</span>}
  </div>
);

const ValidationIssuesList: React.FC<{ issues: ValidationIssue[] }> = ({
  issues,
}) => {
  if (issues.length === 0) return null;
  const preview = issues.slice(0, 8);
  return (
    <ul className="app-tool-preview-issues">
      {preview.map((issue, index) => (
        <li
          key={`${issue.file ?? "issue"}-${issue.line ?? index}`}
          className={`app-tool-preview-issue app-tool-preview-issue--${issue.severity ?? "error"}`}
        >
          <span className="app-tool-preview-issue-sev">
            {issue.severity === "warning" ? "⚠" : "✕"}
          </span>
          <span>
            {issue.file ? `${issue.file}` : "app"}
            {issue.line !== undefined ? `:${issue.line}` : ""}
            {issue.message ? ` — ${issue.message}` : ""}
          </span>
        </li>
      ))}
      {issues.length > preview.length && (
        <li className="app-tool-preview-issue app-tool-preview-issue--more">
          +{issues.length - preview.length} more issue
          {issues.length - preview.length === 1 ? "" : "s"}
        </li>
      )}
    </ul>
  );
};

const ScreenshotGallery: React.FC<{
  screenshots: string[];
  onOpenLive?: () => void;
}> = ({ screenshots, onOpenLive }) => {
  const [index, setIndex] = useState(Math.max(0, screenshots.length - 1));

  useEffect(() => {
    setIndex(Math.max(0, screenshots.length - 1));
  }, [screenshots.length]);

  if (screenshots.length === 0) {
    return null;
  }

  const current = screenshots[index] ?? screenshots[screenshots.length - 1];
  const hasMultiple = screenshots.length > 1;

  return (
    <div className="app-tool-preview-gallery">
      <button
        type="button"
        className="app-tool-preview-screenshot-btn"
        onClick={() => {
          void onOpenLive?.();
        }}
        title="Open the live test browser if it is still running"
      >
        <img
          className="app-tool-preview-screenshot"
          src={current}
          alt={`Agent preview screenshot ${index + 1} of ${screenshots.length}`}
        />
      </button>
      {hasMultiple && (
        <div className="app-tool-preview-gallery-controls">
          <button
            type="button"
            className="app-tool-preview-gallery-nav"
            disabled={index <= 0}
            onClick={() => setIndex((value) => Math.max(0, value - 1))}
          >
            ‹
          </button>
          <span className="app-tool-preview-gallery-count">
            {index + 1} / {screenshots.length}
          </span>
          <button
            type="button"
            className="app-tool-preview-gallery-nav"
            disabled={index >= screenshots.length - 1}
            onClick={() =>
              setIndex((value) => Math.min(screenshots.length - 1, value + 1))
            }
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
};

const HeadlessAgentPreview: React.FC<{
  webviewId?: string;
  isRunning: boolean;
  finalScreenshots: string[];
  runningLabel: string;
  onSessionInactive?: () => void;
}> = ({
  webviewId,
  isRunning,
  finalScreenshots,
  runningLabel,
  onSessionInactive,
}) => {
  const [sessionActive, setSessionActive] = useState<boolean | null>(null);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const openLivePreview = useCallback(async () => {
    const api = window.electronAPI?.agentPreview;
    if (!api) {
      setNotice("Live preview is available in the desktop app.");
      return;
    }
    setOpening(true);
    setNotice(null);
    try {
      const result = await api.show(webviewId);
      if (result.success) {
        setSessionActive(true);
        return;
      }
      setSessionActive(false);
      setNotice(
        result.error === "no_active_session"
          ? "The agent test browser has already closed."
          : "Could not open the live test browser.",
      );
    } catch {
      setNotice("Could not open the live test browser.");
    } finally {
      setOpening(false);
    }
  }, [webviewId]);

  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI?.agentPreview;
    if (!api) {
      setSessionActive(false);
      return;
    }

    async function checkSession() {
      try {
        const activeResult = await api.isActive(webviewId);
        if (!cancelled) {
          setSessionActive(activeResult.active);
        }
      } catch {
        if (!cancelled) {
          setSessionActive(false);
        }
      }
    }

    void checkSession();
    const interval = window.setInterval(() => {
      void checkSession();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [webviewId, isRunning]);

  useEffect(() => {
    if (sessionActive === false && !isRunning && finalScreenshots.length === 0) {
      onSessionInactive?.();
    }
  }, [sessionActive, isRunning, finalScreenshots.length, onSessionInactive]);

  const canWatch = sessionActive === true || isRunning;
  const showLiveCard = isRunning || sessionActive === true;

  if (showLiveCard) {
    return (
      <div className="app-tool-preview-headless">
        <button
          type="button"
          className="app-tool-preview-running-card"
          disabled={!canWatch || opening}
          onClick={() => {
            void openLivePreview();
          }}
        >
          <span className="app-tool-preview-frame-overlay-dot" />
          <span className="app-tool-preview-running-card-title">
            {isRunning
              ? runningLabel
              : "Agent test browser is open"}
          </span>
          <span className="app-tool-preview-running-card-cta">
            {opening ? "Opening…" : "Open test browser window"}
          </span>
        </button>
        <span className="app-tool-preview-action-note">
          This is the headless session the agent controls (not your app tab).
          Actions appear here when the agent uses webview_fill_form / webview_click.
        </span>
        {notice && (
          <span className="app-tool-preview-action-note">{notice}</span>
        )}
        {!canWatch && sessionActive === false && !notice && (
          <span className="app-tool-preview-action-note">
            Waiting for the test browser to start…
          </span>
        )}
        {finalScreenshots.length > 0 && (
          <>
            <span className="app-tool-preview-action-note">
              Last snapshot from the agent (may be stale while the session is
              active):
            </span>
            <ScreenshotGallery
              screenshots={finalScreenshots}
              onOpenLive={openLivePreview}
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="app-tool-preview-headless">
      {finalScreenshots.length > 0 ? (
        <>
          <ScreenshotGallery
            screenshots={finalScreenshots}
            onOpenLive={openLivePreview}
          />
          <span className="app-tool-preview-action-note">
            Captured when the agent checked the preview
            {finalScreenshots.length > 1
              ? ` (${finalScreenshots.length} snapshots)`
              : ""}
            . Flip through them above, or open live if the session is still
            running.
          </span>
        </>
      ) : null}
      {finalScreenshots.length > 0 && (
        <div className="app-tool-preview-actions">
          <button
            type="button"
            className="app-tool-preview-watch-btn"
            disabled={!canWatch || opening}
            onClick={() => {
              void openLivePreview();
            }}
          >
            {opening ? "Opening…" : "Open test browser window"}
          </button>
          {notice && (
            <span className="app-tool-preview-action-note">{notice}</span>
          )}
        </div>
      )}
    </div>
  );
};

function previewHasVisualContent(input: {
  isRunning: boolean;
  finalScreenshots: string[];
  visibleText?: string;
  warnings: string[];
}): boolean {
  const { isRunning, finalScreenshots, visibleText, warnings } = input;
  if (isRunning) {
    return true;
  }
  return (
    finalScreenshots.length > 0 ||
    Boolean(visibleText) ||
    warnings.length > 0
  );
}

export function hasAppToolPreview(
  toolName: string,
  args?: Record<string, unknown>,
  result?: unknown,
  status?: string,
): boolean {
  if (isWebviewSessionPreviewTool(toolName, args)) {
    return false;
  }

  const parsed = parseToolResult(result);
  const data =
    parsed?.data && typeof parsed.data === "object"
      ? (parsed.data as Record<string, unknown>)
      : undefined;
  const isRunning = status === "calling";
  const appId = resolveAppId(toolName, args, parsed);

  switch (toolName) {
    case "validate_app":
      return Boolean(appId);
    case "browser_navigate":
    case "browser_snapshot": {
      const url =
        readString(args?.url) ??
        readString(data?.url) ??
        readString(args?.ref);
      const browserText = readString(data?.text)?.slice(0, 600);
      const screenshot = readString(data?.screenshot);
      return isRunning || Boolean(url || browserText || screenshot);
    }
    case "webview_launch_app":
    case "webview_snapshot":
    case "webview_execute": {
      const visibleText = readString(data?.text)?.slice(0, 600);
      const visualState =
        data?.visualState && typeof data.visualState === "object"
          ? (data.visualState as Record<string, unknown>)
          : undefined;
      const warnings = Array.isArray(visualState?.warnings)
        ? (visualState.warnings as string[])
        : [];
      return previewHasVisualContent({
        isRunning,
        finalScreenshots: extractFinalScreenshots(data),
        visibleText,
        warnings,
      });
    }
    default:
      return false;
  }
}

export const WebviewSessionPreview: React.FC<{
  state: WebviewSessionPreviewState;
}> = ({ state }) => {
  const [expanded, setExpanded] = useState(true);
  const [sessionInactive, setSessionInactive] = useState(false);

  useEffect(() => {
    setSessionInactive(false);
  }, [state.webviewId, state.isActive, state.screenshots.length]);

  if (
    sessionInactive &&
    !state.isActive &&
    state.screenshots.length === 0 &&
    !state.visibleText &&
    state.warnings.length === 0
  ) {
    return null;
  }

  const meta = state.isActive
    ? state.previewTarget === "published"
      ? "Testing (Web)"
      : "Testing (Local)"
    : state.screenshots.length > 0
      ? `${state.screenshots.length} capture${state.screenshots.length === 1 ? "" : "s"}`
      : state.previewTarget === "published"
        ? "Done (Web)"
        : "Done";

  return (
    <div className="app-tool-preview">
      <PreviewHeader
        label="Agent preview"
        meta={meta}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />
      {expanded && (
        <div className="app-tool-preview-body">
          <HeadlessAgentPreview
            webviewId={state.webviewId}
            isRunning={state.isActive}
            finalScreenshots={state.screenshots}
            runningLabel="Agent is testing in the headless browser…"
            onSessionInactive={() => setSessionInactive(true)}
          />
          {state.visibleText && (
            <pre className="app-tool-preview-text">{state.visibleText}</pre>
          )}
          {state.warnings.length > 0 && (
            <ul className="app-tool-preview-warnings">
              {state.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export const AppToolPreview: React.FC<AppToolPreviewProps> = ({
  toolName,
  args,
  result,
  status,
}) => {
  const [expanded, setExpanded] = useState(true);
  const parsed = useMemo(() => parseToolResult(result), [result]);
  const data =
    parsed?.data && typeof parsed.data === "object"
      ? (parsed.data as Record<string, unknown>)
      : undefined;

  const appId = resolveAppId(toolName, args, parsed);
  const isRunning = status === "calling";
  const webviewId = readWebviewId(args, data);
  const finalScreenshots = extractFinalScreenshots(data);

  const usesHeadlessPreview =
    toolName === "validate_app" ||
    (toolName === "webview_execute" &&
      !isWebviewSessionPreviewTool(toolName, args));

  if (toolName === "validate_app" && appId) {
    const issues = Array.isArray(data?.issues)
      ? (data.issues as ValidationIssue[])
      : [];
    const runtimeCheck =
      data?.runtimeCheck && typeof data.runtimeCheck === "object"
        ? (data.runtimeCheck as Record<string, unknown>)
        : undefined;
    const runtimeErrors = Array.isArray(runtimeCheck?.errors)
      ? (runtimeCheck.errors as string[])
      : [];

    const valid = data?.valid === true;
    const meta = valid
      ? "Passed"
      : issues.length > 0
        ? `${issues.filter((i) => i.severity === "error").length} error(s)`
        : runtimeErrors.length > 0
          ? `${runtimeErrors.length} runtime error(s)`
          : "Failed";

    return (
      <div className="app-tool-preview">
        <PreviewHeader
          label="Agent validation"
          meta={meta}
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
        />
        {expanded && (
          <div className="app-tool-preview-body">
            <HeadlessAgentPreview
              webviewId={webviewId}
              isRunning={isRunning}
              finalScreenshots={finalScreenshots}
              runningLabel="Agent is validating in the test browser…"
            />
            <ValidationIssuesList issues={issues} />
            {runtimeErrors.length > 0 && (
              <ul className="app-tool-preview-runtime-errors">
                {runtimeErrors.slice(0, 6).map((line, index) => (
                  <li key={`${index}-${line.slice(0, 24)}`}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  }

  if (usesHeadlessPreview) {
    const visibleText = readString(data?.text)?.slice(0, 600);
    const visualState =
      data?.visualState && typeof data.visualState === "object"
        ? (data.visualState as Record<string, unknown>)
        : undefined;
    const warnings = Array.isArray(visualState?.warnings)
      ? (visualState.warnings as string[])
      : [];

    if (
      !previewHasVisualContent({
        isRunning,
        finalScreenshots,
        visibleText,
        warnings,
      })
    ) {
      return null;
    }

    return (
      <div className="app-tool-preview">
        <PreviewHeader
          label="Agent preview"
          meta={
            isRunning
              ? "Testing"
              : finalScreenshots.length > 0
                ? `${finalScreenshots.length} capture${finalScreenshots.length === 1 ? "" : "s"}`
                : "Done"
          }
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
        />
        {expanded && (
          <div className="app-tool-preview-body">
            <HeadlessAgentPreview
              webviewId={webviewId}
              isRunning={isRunning}
              finalScreenshots={finalScreenshots}
              runningLabel="Agent is testing in the headless browser…"
            />
            {visibleText && (
              <pre className="app-tool-preview-text">{visibleText}</pre>
            )}
            {warnings.length > 0 && (
              <ul className="app-tool-preview-warnings">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  }

  if (toolName === "browser_navigate" || toolName === "browser_snapshot") {
    const url =
      readString(args?.url) ??
      readString(data?.url) ??
      readString(args?.ref);
    const browserText = readString(data?.text)?.slice(0, 600);
    const screenshot = readString(data?.screenshot);

    if (!url && !browserText && !screenshot) return null;

    let hostname: string | undefined;
    if (url) {
      try {
        hostname = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        hostname = undefined;
      }
    }

    return (
      <div className="app-tool-preview">
        <PreviewHeader
          label={url ? "Browser preview" : "Browser snapshot"}
          meta={hostname}
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
        />
        {expanded && (
          <div className="app-tool-preview-body">
            {screenshot && (
              <ScreenshotGallery screenshots={[screenshot]} />
            )}
            {url && !screenshot && (
              <div className="app-tool-preview-browser-url">{url}</div>
            )}
            {browserText && (
              <pre className="app-tool-preview-text">{browserText}</pre>
            )}
          </div>
        )}
      </div>
    );
  }

  return null;
};
