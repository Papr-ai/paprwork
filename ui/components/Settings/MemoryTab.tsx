/**
 * MemoryTab — What Papr knows about you
 *
 * One job: help the user understand their memory at a glance.
 * Liquid Glass · Steve Jobs simplicity · progressive disclosure.
 */

import React, { useEffect, useState } from "react";
import { useCodeIndexing } from "../../hooks/useCodeIndexing";
import { gateway } from "../../src/lib/gateway";
import { Markdown } from "../common/Markdown";
import {
  parseMemoryBootstrapBlock,
  type ParsedMemoryItem,
} from "../Chat/memoryBootstrapDisplay";
import "./MemoryTab.css";

interface WorkspaceFilePreview {
  name: string;
  content: string;
  size: number;
  truncated: boolean;
  rawLength: number;
}

interface PaprMemoryPreview {
  goalsOkrs: string | null;
  useCases: string | null;
  syncTiers: string | null;
}

interface MemoryPreviewStatus {
  paprConfigured: boolean;
  paprUserId: string | null;
  hasSessionToken: boolean;
  isLoggedIn?: boolean;
  errors: {
    goals?: string;
    useCases?: string;
    syncTiers?: string;
  };
}

interface MemoryPreviewCacheInfo {
  fetchedAt: string;
  isStale: boolean;
  fromCache: boolean;
  paprPending?: boolean;
}

type ConnectionLevel = "full" | "partial" | "offline" | "checking";

const FILE_LABELS: Record<string, string> = {
  "IDENTITY.md": "Who you are",
  "BRAND.md": "Your brand",
  "MEMORY.md": "Long-term memory",
  "AGENTS.md": "How Papr works with you",
  "TOOLS.md": "Your environment",
};

function fileLabel(name: string): string {
  if (FILE_LABELS[name]) {
    return FILE_LABELS[name];
  }
  if (name.startsWith("memory/")) {
    const date = name.replace("memory/", "").replace(".md", "");
    return `Daily log · ${date}`;
  }
  return name.replace(".md", "");
}

function connectionLevel(
  status: MemoryPreviewStatus | null,
  electronLoggedIn: boolean | null,
): ConnectionLevel {
  if (electronLoggedIn === null && !status) {
    return "checking";
  }

  const loggedIn =
    status?.isLoggedIn ??
    status?.paprConfigured ??
    electronLoggedIn ??
    false;

  if (!loggedIn) {
    return "offline";
  }
  if (status?.hasSessionToken) {
    return "full";
  }
  return "partial";
}

function connectionLabel(level: ConnectionLevel): string {
  switch (level) {
    case "checking":
      return "Checking connection…";
    case "full":
      return "Connected to Papr";
    case "partial":
      return "Connected to Papr";
    case "offline":
      return "Sign in with Papr";
  }
}

function extractItems(
  content: string | null,
  kind: "parse_goals" | "parse_usecases" | "sync_tiers",
): ParsedMemoryItem[] {
  if (!content) {
    return [];
  }
  const parsed = parseMemoryBootstrapBlock(content, kind);
  return parsed.sections.flatMap((section) => section.items);
}

function extractTierItems(
  content: string | null,
  tierTitle: string,
): ParsedMemoryItem[] {
  if (!content) {
    return [];
  }
  const parsed = parseMemoryBootstrapBlock(content, "sync_tiers");
  const section = parsed.sections.find((s) => s.title.includes(tierTitle));
  return section?.items ?? [];
}

function bodyPreview(body: string, maxLen = 140): string {
  const plain = body
    .replace(/[#*_`[\]]/g, "")
    .replace(/\n+/g, " ")
    .trim();
  return plain.length > maxLen ? `${plain.slice(0, maxLen)}…` : plain;
}

type SectionVariant =
  | "goals"
  | "priority"
  | "recent"
  | "usecases"
  | "context";

function SectionIcon({ variant }: { variant: SectionVariant }) {
  const common = {
    viewBox: "0 0 24 24",
    width: 18,
    height: 18,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (variant) {
    case "goals":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case "priority":
      return (
        <svg {...common}>
          <polygon points="12,3 14.5,9 21,9.5 16,14 17.5,21 12,17.5 6.5,21 8,14 3,9.5 9.5,9" />
        </svg>
      );
    case "recent":
      return (
        <svg {...common}>
          <path d="M12 3v3" />
          <path d="M12 18v3" />
          <path d="M3 12h3" />
          <path d="M18 12h3" />
          <circle cx="12" cy="12" r="5" />
        </svg>
      );
    case "usecases":
      return (
        <svg {...common}>
          <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
        </svg>
      );
    case "context":
      return (
        <svg {...common}>
          <path d="M4 6a2 2 0 012-2h8l6 6v10a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" />
          <path d="M14 4v6h6" />
        </svg>
      );
  }
}

type DetailSelection =
  | { kind: "insight"; title: string; body: string }
  | { kind: "file"; title: string; body: string };

function MemoryDetailSheet({
  selection,
  onClose,
}: {
  selection: DetailSelection | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!selection) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection, onClose]);

  if (!selection) {
    return null;
  }

  return (
    <div
      className="memory-detail-overlay"
      onClick={onClose}
      role="presentation"
    >
      <aside
        className="memory-detail-sheet"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-detail-title"
      >
        <header className="memory-detail-sheet__head">
          <h3 id="memory-detail-title" className="memory-detail-sheet__title">
            {selection.title}
          </h3>
          <button
            type="button"
            className="memory-detail-sheet__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="memory-detail-sheet__body">
          <Markdown>{selection.body}</Markdown>
        </div>
      </aside>
    </div>
  );
}

function SectionPanel({
  variant,
  title,
  hint,
  count,
  action,
  children,
}: {
  variant: SectionVariant;
  title: string;
  hint?: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={`memory-section memory-section--${variant}`}>
      <div className="memory-section__head">
        <div className="memory-section__title-row">
          <span className="memory-section__icon" aria-hidden>
            <SectionIcon variant={variant} />
          </span>
          <div>
            <h3 className="memory-section__title">{title}</h3>
            {hint ? <p className="memory-section__hint">{hint}</p> : null}
          </div>
        </div>
        <div className="memory-section__actions">
          {count !== undefined && count > 0 ? (
            <span className="memory-section__count">{count}</span>
          ) : null}
          {action}
        </div>
      </div>
      <div className="memory-section__body">{children}</div>
    </section>
  );
}

function VisualInsightCard({
  item,
  onOpen,
}: {
  item: ParsedMemoryItem;
  onOpen: () => void;
}) {
  return (
    <article className="memory-visual-card">
      {item.title ? (
        <h4 className="memory-visual-card__title">{item.title}</h4>
      ) : null}
      <p className="memory-visual-card__preview">{bodyPreview(item.body)}</p>
      {item.category || item.memoryType ? (
        <div className="memory-visual-card__meta">
          {item.category ? (
            <span className="memory-visual-card__badge">{item.category}</span>
          ) : null}
          {item.memoryType ? (
            <span className="memory-visual-card__badge">{item.memoryType}</span>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="memory-visual-card__open"
        onClick={onOpen}
      >
        Read full
      </button>
    </article>
  );
}

function ContextFileTile({
  file,
  onOpen,
}: {
  file: WorkspaceFilePreview;
  onOpen: () => void;
}) {
  return (
    <article className="memory-context-tile">
      <span className="memory-context-tile__label">{fileLabel(file.name)}</span>
      <p className="memory-context-tile__snippet">
        {bodyPreview(file.content, 80)}
      </p>
      <button
        type="button"
        className="memory-context-tile__open"
        onClick={onOpen}
      >
        Open
      </button>
    </article>
  );
}

function EmptyState({ message }: { message: string }) {
  return <p className="memory-empty">{message}</p>;
}

function InsightGrid({
  items,
  prefix,
  singleCol,
  onOpenItem,
}: {
  items: ParsedMemoryItem[];
  prefix: string;
  singleCol?: boolean;
  onOpenItem: (item: ParsedMemoryItem) => void;
}) {
  return (
    <div
      className={`memory-card-grid${singleCol ? " memory-card-grid--single-col" : ""}`}
    >
      {items.map((item, i) => (
        <VisualInsightCard
          key={`${prefix}-${i}`}
          item={item}
          onOpen={() => onOpenItem(item)}
        />
      ))}
    </div>
  );
}

function priorityEmptyMessage(
  isLoggedIn: boolean,
  syncTiersError: string | undefined,
  paprLoading: boolean,
): string {
  if (!isLoggedIn) {
    return "Sign in with Papr in AI Models to see ranked memories.";
  }
  if (paprLoading) {
    return "Loading ranked memories from Papr cloud…";
  }
  if (syncTiersError) {
    return "Ranked memories come from Papr cloud sync (Tier 0). The last fetch timed out — tap refresh to try again.";
  }
  return "Papr is still learning. Ranked memories appear as you work together.";
}

export function MemoryTab() {
  const { status: indexStatus, loading: indexLoading, error: indexError } =
    useCodeIndexing();

  const [preview, setPreview] = useState<{
    workspaceFiles: WorkspaceFilePreview[];
    onboardingPending: boolean;
    paprMemory: PaprMemoryPreview;
    status: MemoryPreviewStatus;
    cache?: MemoryPreviewCacheInfo;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [paprLoading, setPaprLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [electronLoggedIn, setElectronLoggedIn] = useState<boolean | null>(
    null,
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [detail, setDetail] = useState<DetailSelection | null>(null);

  useEffect(() => {
    checkPaprLogin();
    void loadPreview(false);
  }, []);

  useEffect(() => {
    const onWorkspaceSwitchStart = () => {
      setPreview(null);
      setDetail(null);
    };
    const onWorkspaceSwitch = () => {
      setPreview(null);
      setDetail(null);
      void loadPreview(true, { silent: true });
    };
    window.addEventListener("papr-workspace-switch-start", onWorkspaceSwitchStart);
    window.addEventListener("papr-workspace-switch-complete", onWorkspaceSwitch);
    return () => {
      window.removeEventListener(
        "papr-workspace-switch-start",
        onWorkspaceSwitchStart,
      );
      window.removeEventListener(
        "papr-workspace-switch-complete",
        onWorkspaceSwitch,
      );
    };
  }, []);

  const checkPaprLogin = async () => {
    try {
      const result = await window.electronAPI.papr.checkLoginStatus();
      setElectronLoggedIn(Boolean(result.success && result.isLoggedIn));
    } catch {
      setElectronLoggedIn(false);
    }
  };

  const loadPreview = async (
    forceRefresh: boolean,
    options?: { silent?: boolean },
  ) => {
    const silent = options?.silent ?? false;

    if (forceRefresh) {
      setRefreshing(true);
    } else if (!silent) {
      setLoading(true);
    }
    if (!silent) {
      setError(null);
    }

    try {
      const response = await gateway.send(
        "memory:get-context-preview",
        { forceRefresh },
        { timeoutMs: forceRefresh ? 60_000 : 15_000 },
      );
      if (response.success && response.data) {
        const data = response.data as {
          workspaceFiles: WorkspaceFilePreview[];
          onboardingPending: boolean;
          paprMemory: PaprMemoryPreview;
          status: MemoryPreviewStatus;
          cache?: MemoryPreviewCacheInfo;
        };
        setPreview(data);
        setPaprLoading(Boolean(data.cache?.paprPending));
      } else if (!silent) {
        setError(response.error ?? "Could not load your memory");
      }
    } catch (err) {
      if (!silent) {
        setError(
          err instanceof Error ? err.message : "Could not load your memory",
        );
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!preview?.cache?.paprPending) {
      setPaprLoading(false);
      return;
    }

    let attempts = 0;
    const maxAttempts = 20;
    const intervalMs = 2_500;

    const timer = window.setInterval(() => {
      attempts += 1;
      if (attempts > maxAttempts) {
        setPaprLoading(false);
        return;
      }
      void loadPreview(false, { silent: true });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [preview?.cache?.paprPending]);

  const openFolder = async (
    payload:
      | { target: "workspace" | "paprHome" }
      | { folderPath: string },
  ) => {
    try {
      await gateway.send("memory:open-folder", payload);
    } catch (err) {
      console.error("Failed to open folder:", err);
    }
  };

  const status = preview?.status ?? null;
  const connection = connectionLevel(status, electronLoggedIn);
  const isLoggedIn =
    status?.isLoggedIn ??
    status?.paprConfigured ??
    electronLoggedIn ??
    false;

  const goals = extractItems(preview?.paprMemory.goalsOkrs ?? null, "parse_goals");
  const useCases = extractItems(
    preview?.paprMemory.useCases ?? null,
    "parse_usecases",
  );
  const priorityMemories = extractTierItems(
    preview?.paprMemory.syncTiers ?? null,
    "Tier 0",
  );
  const recentMemories = extractTierItems(
    preview?.paprMemory.syncTiers ?? null,
    "Tier 1",
  );

  const workspaceFiles = preview?.workspaceFiles ?? [];
  const hasMemoryContent =
    goals.length > 0 ||
    useCases.length > 0 ||
    priorityMemories.length > 0 ||
    recentMemories.length > 0;

  const openInsight = (item: ParsedMemoryItem) => {
    setDetail({
      kind: "insight",
      title: item.title ?? "Memory",
      body: item.body,
    });
  };

  const openFile = (file: WorkspaceFilePreview) => {
    setDetail({
      kind: "file",
      title: fileLabel(file.name),
      body: file.content,
    });
  };

  return (
    <div className="settings-content settings-content--full-width memory-tab">
      <MemoryDetailSheet
        selection={detail}
        onClose={() => setDetail(null)}
      />
      <header className="memory-hero">
        <div className="memory-hero__copy">
          <h2 className="memory-hero__title">What Papr Knows About You</h2>
          <p className="memory-hero__subtitle">
            Your goals, context, and memories — everything Papr uses to work with
            you.
          </p>
        </div>
        <div className="memory-hero__actions">
          <span
            className={`memory-status-pill memory-status-pill--${connection}`}
          >
            <span className="memory-status-pill__dot" />
            {connectionLabel(connection)}
          </span>
          <button
            type="button"
            className="memory-refresh"
            onClick={() => void loadPreview(true)}
            disabled={loading || refreshing}
            aria-label="Refresh memory"
          >
            {loading || refreshing ? "…" : "↻"}
          </button>
        </div>
      </header>

      {preview?.cache?.fromCache && preview.cache.isStale ? (
        <p className="memory-cache-hint">
          Showing saved memory from{" "}
          {new Date(preview.cache.fetchedAt).toLocaleDateString()}. Refreshing in
          the background.
        </p>
      ) : null}

      {paprLoading ? (
        <p className="memory-cache-hint">Loading goals and memories from Papr…</p>
      ) : null}

      {loading && !preview ? (
        <div className="memory-loading-state">
          <div className="memory-loading-shimmer" />
          <div className="memory-loading-shimmer" />
          <div className="memory-loading-shimmer memory-loading-shimmer--wide" />
        </div>
      ) : null}

      {error ? (
        <div className="memory-error-banner">{error}</div>
      ) : null}

      {!loading || preview ? (
        <div className="memory-bento">
          {(goals.length > 0 ||
            priorityMemories.length > 0 ||
            useCases.length > 0 ||
            workspaceFiles.length > 0) && (
            <div className="memory-stats-strip">
              <div className="memory-stat-chip">
                <span className="memory-stat-chip__value">
                  {workspaceFiles.length}
                </span>
                <span className="memory-stat-chip__label">Context files</span>
              </div>
              <div className="memory-stat-chip">
                <span className="memory-stat-chip__value">
                  {priorityMemories.length}
                </span>
                <span className="memory-stat-chip__label">Priorities</span>
              </div>
              <div className="memory-stat-chip">
                <span className="memory-stat-chip__value">{goals.length}</span>
                <span className="memory-stat-chip__label">Goals</span>
              </div>
              <div className="memory-stat-chip">
                <span className="memory-stat-chip__value">
                  {useCases.length}
                </span>
                <span className="memory-stat-chip__label">Use cases</span>
              </div>
            </div>
          )}

          <div className="memory-bento__full">
            <SectionPanel
              variant="context"
              title="Your Context"
              hint={
                preview?.onboardingPending
                  ? "Files Papr reads every conversation · Setup in progress"
                  : "Files Papr reads on every conversation"
              }
              count={workspaceFiles.length}
              action={
                <button
                  type="button"
                  className="memory-link-btn"
                  onClick={() => openFolder({ target: "workspace" })}
                >
                  Open folder
                </button>
              }
            >
              {workspaceFiles.length === 0 ? (
                <EmptyState message="No context files yet. Papr will create them as you work." />
              ) : (
                <div className="memory-context-grid">
                  {workspaceFiles.map((file) => (
                    <ContextFileTile
                      key={file.name}
                      file={file}
                      onOpen={() => openFile(file)}
                    />
                  ))}
                </div>
              )}
            </SectionPanel>
          </div>

          <div className="memory-bento__row memory-bento__row--primary">
            <SectionPanel variant="goals" title="Your Goals" count={goals.length}>
              {status?.errors.goals ? (
                <EmptyState message="Could not load goals right now." />
              ) : goals.length > 0 ? (
                <InsightGrid
                  items={goals}
                  prefix="goal"
                  onOpenItem={openInsight}
                />
              ) : !isLoggedIn ? (
                <EmptyState message="Sign in with Papr in AI Models to see your goals." />
              ) : (
                <EmptyState message="No goals yet. Tell Papr what you're building toward — it will remember." />
              )}
            </SectionPanel>

            <SectionPanel
              variant="priority"
              title="What Matters Most"
              hint="Papr cloud · Tier 0 ranked memories"
              count={priorityMemories.length}
            >
              {priorityMemories.length > 0 ? (
                <InsightGrid
                  items={priorityMemories}
                  prefix="tier0"
                  singleCol
                  onOpenItem={openInsight}
                />
              ) : (
                <EmptyState
                  message={priorityEmptyMessage(
                    isLoggedIn,
                    status?.errors.syncTiers,
                    paprLoading,
                  )}
                />
              )}
            </SectionPanel>
          </div>

          {(recentMemories.length > 0 || useCases.length > 0) && (
            <div className="memory-bento__row memory-bento__row--split">
              {useCases.length > 0 ? (
                <SectionPanel
                  variant="usecases"
                  title="How You Use Papr"
                  count={useCases.length}
                >
                  <InsightGrid
                    items={useCases}
                    prefix="usecase"
                    onOpenItem={openInsight}
                  />
                </SectionPanel>
              ) : null}

              {recentMemories.length > 0 ? (
                <SectionPanel
                  variant="recent"
                  title="Recently Active"
                  count={recentMemories.length}
                >
                  <InsightGrid
                    items={recentMemories}
                    prefix="tier1"
                    onOpenItem={openInsight}
                  />
                </SectionPanel>
              ) : null}
            </div>
          )}

          {!hasMemoryContent && workspaceFiles.length === 0 && isLoggedIn ? (
            <div className="memory-nudge">
              <p>
                Start a conversation. Papr learns your preferences, goals, and
                patterns over time.
              </p>
            </div>
          ) : null}

          <details
            className="memory-advanced"
            open={showAdvanced}
            onToggle={(e) =>
              setShowAdvanced((e.target as HTMLDetailsElement).open)
            }
          >
            <summary>Indexing &amp; storage</summary>
            <div className="memory-advanced__body">
              {indexLoading ? (
                <p className="memory-empty">Loading indexing status…</p>
              ) : indexError ? (
                <p className="memory-empty">Indexing status unavailable</p>
              ) : indexStatus ? (
                <div className="memory-index-grid">
                  <div className="memory-index-stat">
                    <span className="memory-index-stat__value">
                      {indexStatus.chat_stats?.total_chats ?? 0}
                    </span>
                    <span className="memory-index-stat__label">
                      Conversations indexed
                    </span>
                  </div>
                  <div className="memory-index-stat">
                    <span className="memory-index-stat__value">
                      {indexStatus.status?.stats.total_files ?? 0}
                    </span>
                    <span className="memory-index-stat__label">
                      Code files indexed
                    </span>
                  </div>
                  <div className="memory-index-stat">
                    <span
                      className={`memory-index-stat__badge ${
                        indexStatus.enabled
                          ? "memory-index-stat__badge--on"
                          : ""
                      }`}
                    >
                      {indexStatus.enabled ? "Active" : "Inactive"}
                    </span>
                    <span className="memory-index-stat__label">
                      Cloud memory
                    </span>
                  </div>
                </div>
              ) : null}
              <button
                type="button"
                className="memory-link-btn memory-link-btn--block"
                onClick={() => openFolder({ target: "paprHome" })}
              >
                Open Papr data folder
              </button>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}
