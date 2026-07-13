import React, { useCallback, useEffect, useState } from "react";
import {
  accessModeToSharingSettings,
  formatShareLink,
  sharingSettingsRequireShareToken,
  type CloudExternalLink,
  type CloudLoginAccess,
} from "../../utils/cloudShareLink";
import "./CloudSyncDetails.css";

type ItemStatus = "synced" | "pending" | "outdated" | "empty" | "unavailable";

interface GitHubSyncItem {
  id: string;
  kind: "app" | "job" | "folder";
  label: string;
  relativePath: string;
  status: "synced" | "pending" | "outdated";
  lastSyncAt: string | null;
}

interface GitHubSyncItemsReport {
  workspace: GitHubSyncItem[];
  apps: GitHubSyncItem[];
  jobs: GitHubSyncItem[];
  queuedPaths?: string[];
  summary: {
    synced: number;
    pending: number;
    outdated: number;
    total: number;
  };
}

interface TursoSourceSyncItem {
  appId: string;
  jobId: string;
  alias: string;
  role: string;
  tursoDatabase?: string;
  status: "synced" | "pending" | "empty" | "unavailable";
  localTableCount: number;
  remoteTableCount: number;
}

interface TursoSyncItemsReport {
  enabled: boolean;
  databaseMode?: "per-job";
  database?: string;
  error: string | null;
  sources: TursoSourceSyncItem[];
  summary: {
    synced: number;
    pending: number;
    empty: number;
    unavailable: number;
    total: number;
  };
}

type CloudAccessMode =
  | "private"
  | "team"
  | "link_read"
  | "link_read_write"
  | "public_read";

interface CloudLinkSyncItem {
  appId: string;
  label: string;
  enabled: boolean;
  shareUrl: string | null;
  shareLink?: string | null;
  shareToken?: string | null;
  accessMode: CloudAccessMode;
  loginAccess?: CloudLoginAccess;
  externalLink?: CloudExternalLink;
  autoPublish: boolean;
  status: "live" | "pending" | "disabled" | "unavailable";
  lastError: string | null;
}

interface PublishApiResponse {
  appId: string;
  accessMode: CloudAccessMode;
  loginAccess?: CloudLoginAccess;
  externalLink?: CloudExternalLink;
  shareUrl: string | null;
  shareToken?: string | null;
  enabled: boolean;
  error?: string;
}

interface CloudLinkSyncReport {
  enabled: boolean;
  globalAutoPublishEnabled?: boolean;
  appsHost: string;
  error: string | null;
  items: CloudLinkSyncItem[];
  summary: {
    live: number;
    pending: number;
    disabled: number;
    unavailable: number;
    total: number;
  };
}

export interface SyncItemsResponse {
  enabled: boolean;
  github?: GitHubSyncItemsReport | null;
  turso?: TursoSyncItemsReport | null;
  cloudLinks?: CloudLinkSyncReport | null;
  appContext?: {
    appId: string;
    dependentJobIds: string[];
  };
  reason?: string;
}

const LOGIN_ACCESS_LABELS: Record<CloudLoginAccess, string> = {
  private: "Private (you)",
  team: "Team",
  public: "Public",
  none: "No Papr login",
};

const EXTERNAL_LINK_LABELS: Record<CloudExternalLink, string> = {
  off: "Off",
  read: "View only (invite)",
  read_write: "Use app (read & write data)",
};

function resolveItemSharing(item: CloudLinkSyncItem): {
  loginAccess: CloudLoginAccess;
  externalLink: CloudExternalLink;
} {
  if (item.loginAccess !== undefined || item.externalLink !== undefined) {
    return {
      loginAccess: item.loginAccess ?? "private",
      externalLink: item.externalLink ?? "off",
    };
  }
  return accessModeToSharingSettings(item.accessMode);
}

function statusMeta(status: ItemStatus): { color: string; label: string } {
  switch (status) {
    case "synced":
      return { color: "#34c759", label: "Synced" };
    case "pending":
      return { color: "#ff9500", label: "Pending" };
    case "outdated":
      return { color: "#ff9500", label: "Changed" };
    case "empty":
      return { color: "#8e8e93", label: "Empty" };
    case "unavailable":
      return { color: "#8e8e93", label: "No DB" };
    default:
      return { color: "#8e8e93", label: "Unknown" };
  }
}

function cloudLinkStatusMeta(
  status: CloudLinkSyncItem["status"],
): { color: string; label: string } {
  switch (status) {
    case "live":
      return { color: "#34c759", label: "Live" };
    case "pending":
      return { color: "#ff9500", label: "Pending" };
    case "disabled":
      return { color: "#8e8e93", label: "Off" };
    case "unavailable":
      return { color: "#ff3b30", label: "Error" };
    default:
      return { color: "#8e8e93", label: "Unknown" };
  }
}

function formatRelativeTime(isoStr: string | null): string {
  if (!isoStr) return "";
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function SyncItemRow({
  label,
  status,
  meta,
}: {
  label: string;
  status: ItemStatus;
  meta?: string;
}) {
  const dot = statusMeta(status);
  return (
    <div className="cloud-sync-details__row">
      <div className="cloud-sync-details__label">
        <span className="cloud-sync-details__dot" style={{ background: dot.color }} />
        <span className="cloud-sync-details__name" title={label}>
          {label}
        </span>
      </div>
      <span className="cloud-sync-details__meta">
        {dot.label}
        {meta ? ` · ${meta}` : ""}
      </span>
    </div>
  );
}

function CloudLinkCard({
  item,
  onRefresh,
  onMessage,
  onItemUpdated,
}: {
  item: CloudLinkSyncItem;
  onRefresh: () => void;
  onMessage: (message: { type: "success" | "error"; text: string }) => void;
  onItemUpdated: (appId: string, patch: Partial<CloudLinkSyncItem>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const initialSharing = resolveItemSharing(item);
  const [loginAccess, setLoginAccess] = useState<CloudLoginAccess>(
    initialSharing.loginAccess,
  );
  const [externalLink, setExternalLink] = useState<CloudExternalLink>(
    initialSharing.externalLink,
  );
  const [shareLink, setShareLink] = useState(
    item.shareLink ?? item.shareUrl,
  );
  const dot = cloudLinkStatusMeta(item.status);

  useEffect(() => {
    const sharing = resolveItemSharing(item);
    setLoginAccess(sharing.loginAccess);
    setExternalLink(sharing.externalLink);
    const incoming = item.shareLink ?? item.shareUrl;
    setShareLink((prev) => {
      if (
        sharingSettingsRequireShareToken({ externalLink: sharing.externalLink }) &&
        prev?.includes("?t=") &&
        incoming &&
        !incoming.includes("?t=")
      ) {
        return prev;
      }
      return incoming;
    });
  }, [item.accessMode, item.externalLink, item.loginAccess, item.shareLink, item.shareUrl]);

  const applyPublishResponse = useCallback(
    (body: PublishApiResponse) => {
      const sharing = {
        loginAccess: body.loginAccess ?? loginAccess,
        externalLink: body.externalLink ?? externalLink,
      };
      const nextLink =
        formatShareLink(
          body.shareUrl,
          body.shareToken,
          body.accessMode,
          sharingSettingsRequireShareToken(sharing),
        ) ?? body.shareUrl;
      setLoginAccess(sharing.loginAccess);
      setExternalLink(sharing.externalLink);
      setShareLink(nextLink);
      onItemUpdated(item.appId, {
        accessMode: body.accessMode,
        loginAccess: sharing.loginAccess,
        externalLink: sharing.externalLink,
        shareUrl: body.shareUrl,
        shareToken: body.shareToken ?? null,
        shareLink: nextLink,
        enabled: body.enabled,
        status: body.enabled && body.shareUrl ? "live" : item.status,
      });
    },
    [externalLink, item.appId, item.status, loginAccess, onItemUpdated],
  );

  const publish = useCallback(
    async (nextSharing: {
      loginAccess: CloudLoginAccess;
      externalLink: CloudExternalLink;
    }) => {
      const previousLogin = loginAccess;
      const previousExternal = externalLink;
      const previousLink = shareLink;
      setLoginAccess(nextSharing.loginAccess);
      setExternalLink(nextSharing.externalLink);
      setBusy(true);
      try {
        const res = await fetch(
          `http://localhost:18789/api/cloud/publish/${encodeURIComponent(item.appId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              loginAccess: nextSharing.loginAccess,
              externalLink: nextSharing.externalLink,
              autoPublish: true,
            }),
          },
        );
        const body = (await res.json()) as PublishApiResponse;
        if (!res.ok) {
          throw new Error(body.error ?? `Publish failed (${res.status})`);
        }
        applyPublishResponse(body);
        const linkNote = sharingSettingsRequireShareToken(nextSharing)
          ? body.shareToken
            ? " External link includes access token."
            : " Memory server did not return a share token yet."
          : "";
        onMessage({
          type: "success",
          text: `${item.label}: ${LOGIN_ACCESS_LABELS[nextSharing.loginAccess]} · ${EXTERNAL_LINK_LABELS[nextSharing.externalLink]}${linkNote}`,
        });
        onRefresh();
      } catch (error) {
        setLoginAccess(previousLogin);
        setExternalLink(previousExternal);
        setShareLink(previousLink);
        onMessage({
          type: "error",
          text:
            error instanceof Error
              ? error.message.slice(0, 200)
              : "Publish failed",
        });
      } finally {
        setBusy(false);
      }
    },
    [
      applyPublishResponse,
      externalLink,
      item.appId,
      item.label,
      loginAccess,
      onMessage,
      onRefresh,
      shareLink,
    ],
  );

  const unpublish = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(
        `http://localhost:18789/api/cloud/publish/${encodeURIComponent(item.appId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Unpublish failed");
      }
      onMessage({ type: "success", text: `${item.label}: unpublished` });
      onRefresh();
    } catch (error) {
      onMessage({
        type: "error",
        text:
          error instanceof Error
            ? error.message.slice(0, 200)
            : "Unpublish failed",
      });
    } finally {
      setBusy(false);
    }
  }, [item.appId, item.label, onMessage, onRefresh]);

  const setAutoPublish = useCallback(
    async (autoPublish: boolean) => {
      setBusy(true);
      try {
        const res = await fetch(
          `http://localhost:18789/api/cloud/publish/${encodeURIComponent(item.appId)}/prefs`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ autoPublish }),
          },
        );
        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          throw new Error(body.error ?? "Failed to update auto-publish");
        }
        onMessage({
          type: "success",
          text: `${item.label}: auto-publish ${autoPublish ? "on" : "off"}`,
        });
        onRefresh();
      } catch (error) {
        onMessage({
          type: "error",
          text:
            error instanceof Error
              ? error.message.slice(0, 200)
              : "Update failed",
        });
      } finally {
        setBusy(false);
      }
    },
    [item.appId, item.label, onMessage, onRefresh],
  );

  const copyUrl = useCallback(async (link: string | null | undefined) => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      onMessage({ type: "success", text: "Link copied to clipboard" });
    } catch {
      onMessage({ type: "error", text: "Could not copy link" });
    }
  }, [onMessage]);

  const baseUrl =
    item.shareUrl ??
    (shareLink?.includes("?") ? shareLink.split("?")[0] : shareLink) ??
    null;
  const externalLinkUrl =
    sharingSettingsRequireShareToken({ externalLink }) && shareLink?.includes("?t=")
      ? shareLink
      : null;
  const loginUrl =
    loginAccess === "none"
      ? null
      : externalLinkUrl
        ? baseUrl
        : shareLink ?? item.shareUrl;

  return (
    <div
      className={
        busy
          ? "cloud-sync-details__app-card cloud-sync-details__app-card--busy"
          : "cloud-sync-details__app-card"
      }
    >
      <div className="cloud-sync-details__app-header">
        <div className="cloud-sync-details__app-title">
          <span className="cloud-sync-details__dot" style={{ background: dot.color }} />
          <span className="cloud-sync-details__name">{item.label}</span>
          <span className="cloud-sync-details__badge">{dot.label}</span>
          {busy ? (
            <span className="cloud-sync-details__badge cloud-sync-details__badge--busy">
              Updating…
            </span>
          ) : null}
        </div>
        <label className="cloud-sync-details__auto-toggle">
          <input
            type="checkbox"
            checked={item.autoPublish}
            disabled={busy}
            onChange={(event) => {
              void setAutoPublish(event.target.checked);
            }}
          />
          <span>Auto-publish</span>
        </label>
      </div>

      {busy ? (
        <div className="cloud-sync-details__url cloud-sync-details__url--muted">
          Updating sharing settings…
        </div>
      ) : (
        <>
          {loginUrl ? (
            <div className="cloud-sync-details__url" title={loginUrl}>
              <span className="cloud-sync-details__url-label">Papr login URL</span>
              {loginUrl}
            </div>
          ) : null}
          {externalLinkUrl ? (
            <div className="cloud-sync-details__url" title={externalLinkUrl}>
              <span className="cloud-sync-details__url-label">External link</span>
              {externalLinkUrl}
            </div>
          ) : null}
          {!loginUrl && !externalLinkUrl && item.lastError ? (
            <div className="cloud-sync-details__url cloud-sync-details__url--error">
              {item.lastError.slice(0, 120)}
            </div>
          ) : null}
          {!loginUrl && !externalLinkUrl && !item.lastError ? (
            <div className="cloud-sync-details__url cloud-sync-details__url--muted">
              Not published yet
            </div>
          ) : null}
        </>
      )}

      {sharingSettingsRequireShareToken({ externalLink }) &&
      !shareLink?.includes("?t=") ? (
        <div className="cloud-sync-details__hint">
          External link needs a token from Papr cloud. Republish or check memory
          server logs if the URL has no <code>?t=</code>.
        </div>
      ) : null}

      <div className="cloud-sync-details__sharing-grid">
        <fieldset className="cloud-sync-details__sharing-fieldset" disabled={busy}>
          <legend>Papr login access</legend>
          {(Object.keys(LOGIN_ACCESS_LABELS) as CloudLoginAccess[]).map((mode) => (
            <label key={mode} className="cloud-sync-details__radio">
              <input
                type="radio"
                name={`login-${item.appId}`}
                checked={loginAccess === mode}
                onChange={() => {
                  void publish({ loginAccess: mode, externalLink });
                }}
              />
              <span>{LOGIN_ACCESS_LABELS[mode]}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="cloud-sync-details__sharing-fieldset" disabled={busy}>
          <legend>External link</legend>
          <p className="cloud-sync-details__sharing-note">
            Controls in-app data (forms, edit buttons) — not app source code. To
            fork or edit the app, use Export or give teammates Papr login in
            Paprwork.
          </p>
          {(Object.keys(EXTERNAL_LINK_LABELS) as CloudExternalLink[]).map((mode) => (
            <label key={mode} className="cloud-sync-details__radio">
              <input
                type="radio"
                name={`external-${item.appId}`}
                checked={externalLink === mode}
                onChange={() => {
                  void publish({ loginAccess, externalLink: mode });
                }}
              />
              <span>{EXTERNAL_LINK_LABELS[mode]}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <div className="cloud-sync-details__app-actions">
        {externalLinkUrl ? (
          <button
            type="button"
            className="cloud-sync-details__button"
            disabled={busy}
            onClick={() => void copyUrl(externalLinkUrl)}
          >
            Copy external link
          </button>
        ) : null}
        {loginUrl ? (
          <button
            type="button"
            className="cloud-sync-details__button"
            disabled={busy}
            onClick={() => void copyUrl(loginUrl)}
          >
            Copy login URL
          </button>
        ) : null}
        {shareLink || item.shareUrl ? (
          <button
            type="button"
            className="cloud-sync-details__button"
            disabled={busy}
            onClick={() => void unpublish()}
          >
            Unpublish
          </button>
        ) : (
          <button
            type="button"
            className="cloud-sync-details__button cloud-sync-details__button--primary"
            disabled={busy}
            onClick={() => void publish({ loginAccess, externalLink })}
          >
            Publish
          </button>
        )}
      </div>
    </div>
  );
}

function CollapsibleSection({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <details className="cloud-sync-details__collapse">
      <summary className="cloud-sync-details__collapse-summary">
        <span>{title}</span>
        <span className="cloud-sync-details__summary">{summary}</span>
      </summary>
      <div className="cloud-sync-details__collapse-body">{children}</div>
    </details>
  );
}

function ItemList<T>({
  emptyMessage,
  items,
  renderRow,
}: {
  emptyMessage: string;
  items: T[];
  renderRow: (item: T) => React.ReactNode;
}) {
  if (items.length === 0) {
    return <div className="cloud-sync-details__empty">{emptyMessage}</div>;
  }
  return <div className="cloud-sync-details__list">{items.map(renderRow)}</div>;
}

export const CloudSyncDetails: React.FC<{
  data: SyncItemsResponse | null;
  onRefresh?: () => void;
  onItemUpdated?: (appId: string, patch: Partial<CloudLinkSyncItem>) => void;
  globalAutoPublishEnabled?: boolean;
  refreshing?: boolean;
}> = ({
  data,
  onRefresh,
  onItemUpdated,
  globalAutoPublishEnabled = true,
  refreshing = false,
}) => {
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  const handleMessage = useCallback(
    (next: { type: "success" | "error"; text: string }) => {
      setMessage(next);
    },
    [],
  );

  const handleItemUpdated = useCallback(
    (appId: string, patch: Partial<CloudLinkSyncItem>) => {
      onItemUpdated?.(appId, patch);
    },
    [onItemUpdated],
  );

  if (!data?.enabled || !data.github) {
    return null;
  }

  const github = data.github;
  const turso = data.turso;
  const cloudLinks = data.cloudLinks;
  const refresh = onRefresh ?? (() => undefined);
  const appsHost = cloudLinks?.appsHost ?? "apps.papr.ai";
  const items = cloudLinks?.items ?? [];
  const liveItems = items.filter((item) => item.status === "live");
  const otherItems = items.filter((item) => item.status !== "live");

  return (
    <div className="cloud-sync-details">
      {message ? (
        <div
          className={
            message.type === "success"
              ? "cloud-sync-details__toast cloud-sync-details__toast--success"
              : "cloud-sync-details__toast cloud-sync-details__toast--error"
          }
        >
          {message.text}
        </div>
      ) : null}

      <section className="cloud-sync-details__section cloud-sync-details__section--primary">
        <div className="cloud-sync-details__heading">
          <span>Published apps{refreshing ? " · refreshing…" : ""}</span>
          <span className="cloud-sync-details__summary">
            {cloudLinks
              ? `${cloudLinks.summary.live}/${cloudLinks.summary.total} live · ${appsHost}`
              : appsHost}
          </span>
        </div>

        {!globalAutoPublishEnabled ? (
          <div className="cloud-sync-details__hint">
            Global auto-publish is off. Publish manually below or enable it in
            Preferences.
          </div>
        ) : null}
        {cloudLinks?.error ? (
          <div className="cloud-sync-details__error">
            {cloudLinks.error.slice(0, 160)}
          </div>
        ) : null}

        {items.length === 0 ? (
          <div className="cloud-sync-details__empty">
            No mini-apps yet. Apps appear here after workspace sync.
          </div>
        ) : (
          <>
            {liveItems.length > 0 ? (
              <div className="cloud-sync-details__app-group">
                <h4 className="cloud-sync-details__group-title">Live</h4>
                <div className="cloud-sync-details__app-grid">
                  {liveItems.map((item) => (
                    <CloudLinkCard
                      key={item.appId}
                      item={item}
                      onRefresh={refresh}
                      onMessage={handleMessage}
                      onItemUpdated={handleItemUpdated}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {otherItems.length > 0 ? (
              <div className="cloud-sync-details__app-group">
                <h4 className="cloud-sync-details__group-title">
                  {liveItems.length > 0 ? "Not live" : "All apps"}
                </h4>
                <div className="cloud-sync-details__app-grid">
                  {otherItems.map((item) => (
                    <CloudLinkCard
                      key={item.appId}
                      item={item}
                      onRefresh={refresh}
                      onMessage={handleMessage}
                      onItemUpdated={handleItemUpdated}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>

      <CollapsibleSection
        title="GitHub sync inventory"
        summary={`${github.summary.synced}/${github.summary.total} synced`}
      >
        <ItemList
          emptyMessage="No workspace folders."
          items={github.workspace}
          renderRow={(item) => (
            <SyncItemRow
              key={item.relativePath}
              label={`Workspace · ${item.label}`}
              status={item.status}
              meta={formatRelativeTime(item.lastSyncAt)}
            />
          )}
        />
        <ItemList
          emptyMessage="No apps in ~/Papr/apps."
          items={github.apps}
          renderRow={(item) => (
            <SyncItemRow
              key={item.id}
              label={item.label}
              status={item.status}
              meta={formatRelativeTime(item.lastSyncAt)}
            />
          )}
        />
        <ItemList
          emptyMessage="No jobs in ~/Papr/Jobs."
          items={github.jobs}
          renderRow={(item) => (
            <SyncItemRow
              key={item.relativePath}
              label={item.label}
              status={item.status}
              meta={formatRelativeTime(item.lastSyncAt)}
            />
          )}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Linked databases (Turso)"
        summary={
          turso
            ? `${turso.summary.synced}/${turso.summary.total} synced`
            : "Checking…"
        }
      >
        {turso?.error ? (
          <div className="cloud-sync-details__error">{turso.error.slice(0, 160)}</div>
        ) : null}
        <ItemList
          emptyMessage="No linked databases. Link a job DB in a mini-app first."
          items={turso?.sources ?? []}
          renderRow={(item) => (
            <SyncItemRow
              key={`${item.appId}:${item.jobId}:${item.alias}`}
              label={item.alias}
              status={item.status}
              meta={
                item.status === "synced"
                  ? `${item.remoteTableCount} tables`
                  : item.localTableCount > 0
                    ? `${item.localTableCount} local`
                    : item.role
              }
            />
          )}
        />
      </CollapsibleSection>
    </div>
  );
};
