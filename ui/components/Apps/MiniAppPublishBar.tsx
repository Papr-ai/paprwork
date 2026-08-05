/**
 * MiniAppPublishBar — publish, share, preview mode controls.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { useCloudPublish } from "../../hooks/useCloudPublish";
import { useAppCloudSyncStatus } from "../../hooks/useAppCloudSyncStatus";
import {
  formatWebSyncStatusTooltip,
  webSyncVisualState,
} from "../../utils/appCloudSyncStatus";
import {
  isCodePermission,
  isPermissionAvailable,
  isWebLinkPermission,
  sharingToAudienceModel,
  shouldListInCommunity,
  type ShareAudience,
  type ShareAudienceModel,
  type SharePermission,
} from "../../utils/shareAudienceModel";
import type { ArtifactCloudLineage } from "../../stores/artifactsStore";
import {
  buildUpstreamCloudPreviewUrl,
  buildUpstreamPublishedWebUrl,
} from "../../utils/cloudDesktopPreview";
import { CloudChangeRequestsPanel } from "./CloudChangeRequestsPanel";
import { CloudContributeBackPanel } from "./CloudContributeBackPanel";
import { CloudUpstreamBar } from "./CloudUpstreamBar";
import { CloudAppCredentialsPanel } from "./CloudAppCredentialsPanel";
import { AppWorkspaceMenu } from "./AppWorkspaceMenu";
import { WebSyncPopover, WebSyncStatusDot } from "./WebSyncPopover";
import type { AppWorkspaceMode } from "../../hooks/useAppWorkspace";
import {
  CloudCompatibilityBadge,
  CloudCompatibilityPanel,
} from "./CloudCompatibilityPanel";
import {
  CloudPublishBlockedError,
  fetchCloudCompatibility,
} from "../../utils/cloudPublishApi";
import type { CloudCompatibilityReport } from "../../src/core/types/cloudAppCompatibility";
import "./MiniAppPublishBar.css";
import "./AppWorkspaceMenu.css";

export type AppPreviewMode = "local" | "published";

export type CloudPublishControls = ReturnType<typeof useCloudPublish>;

interface MiniAppPublishBarProps {
  appId: string;
  appTitle: string;
  cloud: CloudPublishControls;
  cloudLineage?: ArtifactCloudLineage | null;
  viewMode: AppPreviewMode;
  onViewModeChange: (mode: AppPreviewMode) => void;
  workspaceMode: AppWorkspaceMode;
  onWorkspaceModeChange: (mode: AppWorkspaceMode) => void;
  onTrackPullComplete?: () => void;
  onRefreshPreview?: () => void;
}

const ACCESS_OPTIONS: {
  value: ShareAudience;
  label: string;
  description: string;
}[] = [
  {
    value: "private",
    label: "Only me",
    description: "Just you — sign in with Papr to open it",
  },
  {
    value: "team",
    label: "Anyone in my workspace",
    description: "People in your Papr workspace — sign in required",
  },
  {
    value: "link",
    label: "Anyone with the link",
    description: "Unlisted — share via link (optionally require Papr sign-in)",
  },
  {
    value: "public",
    label: "Public in Community Apps",
    description: "Listed in Community Apps — any Papr user can discover and open it",
  },
];

const PERMISSION_OPTIONS: {
  value: SharePermission;
  label: string;
  description: string;
}[] = [
  {
    value: "write",
    label: "Can view and interact",
    description: "Open the app, read data, and use interactive features",
  },
  {
    value: "edit",
    label: "Can edit code",
    description: "Install into Paprwork to customize and send changes back",
  },
];

function formatShareSelectionSummary(
  audience: ShareAudience,
  permission: SharePermission,
  requireSignIn: boolean,
): string {
  const accessLabel =
    ACCESS_OPTIONS.find((option) => option.value === audience)?.label ?? audience;
  if (audience === "private") {
    return accessLabel;
  }
  const permissionLabel =
    PERMISSION_OPTIONS.find((option) => option.value === permission)?.label ??
    permission;
  const parts = [accessLabel, permissionLabel];
  if (audience === "link") {
    parts.push(requireSignIn ? "Sign-in required" : "No sign-in required");
  }
  return parts.join(" · ");
}

interface ShareSheetProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

function ShareSheet({ title, onClose, children }: ShareSheetProps) {
  return createPortal(
    <div className="share-sheet__backdrop" role="presentation" onClick={onClose}>
      <div
        className="share-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="share-sheet__header">
          <h3 id="share-sheet-title" className="share-sheet__title">
            {title}
          </h3>
          <button
            type="button"
            className="share-sheet__close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function OpenExternalIcon() {
  return (
    <svg className="share-sheet__icon" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M10.5 2.5H13.5V5.5M8.5 7.5L13 3M6.5 3H3.5C2.95 3 2.5 3.45 2.5 4V12.5C2.5 13.05 2.95 13.5 3.5 13.5H12C12.55 13.5 13 13.05 13 12.5V9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg className="share-sheet__icon" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.5 10.5H3.5C2.95 10.5 2.5 10.05 2.5 9.5V3.5C2.5 2.95 2.95 2.5 3.5 2.5H9.5C10.05 2.5 10.5 2.95 10.5 3.5V4.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg className="share-sheet__icon" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13.5 8a5.5 5.5 0 01-9.2 4M2.5 8a5.5 5.5 0 019.2-4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M11.5 2.5V5.5H8.5M4.5 13.5V10.5H7.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MiniAppPublishBar({
  appId,
  appTitle,
  cloud,
  cloudLineage = null,
  viewMode,
  onViewModeChange,
  workspaceMode,
  onWorkspaceModeChange,
  onTrackPullComplete,
  onRefreshPreview,
}: MiniAppPublishBarProps) {
  const [shareOpen, setShareOpen] = useState(false);
  const [audience, setAudience] = useState<ShareAudience>("private");
  const [permission, setPermission] = useState<SharePermission>("write");
  const [requireSignIn, setRequireSignIn] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | undefined>(
    cloudLineage?.lastSyncedAt,
  );
  const [webSyncPopoverOpen, setWebSyncPopoverOpen] = useState(false);
  const webSyncAnchorRef = useRef<HTMLDivElement>(null);
  const webSyncPopoverRef = useRef<HTMLDivElement>(null);
  const [webSyncPopoverPos, setWebSyncPopoverPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [shareSyncNotice, setShareSyncNotice] = useState<string | null>(null);
  const applyingSharingRef = useRef(false);
  const [compatReport, setCompatReport] = useState<CloudCompatibilityReport | null>(
    cloud.compatibility,
  );
  const [compatLoading, setCompatLoading] = useState(false);
  const [needsDesktopAck, setNeedsDesktopAck] = useState(false);

  const { status: webSyncStatus, loading: webSyncLoading, refreshing: webSyncRefreshing, pushing: webSyncPushing, pulling: webSyncPulling, error: webSyncError, pushNow: webSyncPushNow, pullUpdates: webSyncPullUpdates } =
    useAppCloudSyncStatus(appId, { enabled: workspaceMode === "preview" });

  useEffect(() => {
    setCompatReport(cloud.compatibility);
  }, [cloud.compatibility]);

  useEffect(() => {
    if (!shareOpen) {
      setNeedsDesktopAck(false);
      setShareSyncNotice(null);
      return;
    }
    setCompatLoading(true);
    void fetchCloudCompatibility(appId)
      .then(setCompatReport)
      .catch(() => {
        if (cloud.compatibility) setCompatReport(cloud.compatibility);
      })
      .finally(() => setCompatLoading(false));
  }, [shareOpen, appId, cloud.compatibility]);

  useEffect(() => {
    setLastSyncedAt(cloudLineage?.lastSyncedAt);
  }, [cloudLineage?.lastSyncedAt, cloudLineage?.mode]);

  useEffect(() => {
    if (!shareOpen || applyingSharingRef.current) return;
    const model = sharingToAudienceModel(
      cloud.loginAccess,
      cloud.externalLink,
      cloud.codeAccess,
    );
    setAudience(model.audience);
    setPermission(model.permission);
    setRequireSignIn(model.requireSignIn !== false);
  }, [shareOpen, cloud.loginAccess, cloud.externalLink, cloud.codeAccess]);

  useEffect(() => {
    if (!shareOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShareOpen(false);
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [shareOpen]);

  const updateWebSyncPopoverPos = useCallback(() => {
    const anchor = webSyncAnchorRef.current;
    if (!anchor) {
      setWebSyncPopoverPos(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setWebSyncPopoverPos({ top: rect.bottom + 8, left: rect.left });
  }, []);

  useEffect(() => {
    if (!webSyncPopoverOpen) {
      setWebSyncPopoverPos(null);
      return;
    }
    updateWebSyncPopoverPos();
    window.addEventListener("resize", updateWebSyncPopoverPos);
    window.addEventListener("scroll", updateWebSyncPopoverPos, true);
    return () => {
      window.removeEventListener("resize", updateWebSyncPopoverPos);
      window.removeEventListener("scroll", updateWebSyncPopoverPos, true);
    };
  }, [webSyncPopoverOpen, updateWebSyncPopoverPos]);

  useEffect(() => {
    if (!webSyncPopoverOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        webSyncAnchorRef.current?.contains(target) ||
        webSyncPopoverRef.current?.contains(target)
      ) {
        return;
      }
      setWebSyncPopoverOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWebSyncPopoverOpen(false);
    };
    const timer = window.setTimeout(() => {
      window.addEventListener("mousedown", onPointerDown);
    }, 0);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [webSyncPopoverOpen]);

  useEffect(() => {
    if (workspaceMode !== "preview") {
      setWebSyncPopoverOpen(false);
    }
  }, [workspaceMode]);

  const applySharing = async (
    nextAudience: ShareAudience,
    nextPermission: SharePermission,
    nextRequireSignIn = requireSignIn,
  ) => {
    setAudience(nextAudience);
    setPermission(nextPermission);
    if (nextAudience === "link") {
      setRequireSignIn(nextRequireSignIn);
    }
    const model: ShareAudienceModel = {
      audience: nextAudience,
      permission: nextPermission,
      requireSignIn: nextAudience === "link" ? nextRequireSignIn : undefined,
    };
    if (!isPermissionAvailable(nextAudience, nextPermission)) return;

    const needsCloudPublish =
      model.permission !== "edit" || model.audience !== "private";

    applyingSharingRef.current = true;
    setShareSyncNotice("Saving sharing settings…");
    try {
      await cloud.updateSharing(model);
      if (needsCloudPublish) {
        setShareSyncNotice("Uploading app code and databases to the web…");
        await webSyncPushNow();
      }
    } finally {
      applyingSharingRef.current = false;
      setShareSyncNotice(null);
    }
  };

  const pickAudience = (nextAudience: ShareAudience) => {
    let nextPermission = permission;
    if (!isPermissionAvailable(nextAudience, nextPermission)) {
      nextPermission = "write";
    }
    const nextRequireSignIn = nextAudience === "link" ? true : requireSignIn;
    applySharing(nextAudience, nextPermission, nextRequireSignIn);
  };

  const pickPermission = (nextPermission: SharePermission) => {
    if (!isPermissionAvailable(audience, nextPermission)) return;
    applySharing(audience, nextPermission);
  };

  const openCloudInstallHelp = () => {
    setShareOpen(false);
    window.dispatchEvent(
      new CustomEvent("papr-chat-open", {
        detail: {
          message:
            `Help me install the Papr Cloud app "${appTitle}" (${appId}) into my Paprwork. ` +
            `Sync the source from papr-work, set up any jobs or dependencies, and explain how I can fork it or send changes back to the owner for approval.`,
        },
      }),
    );
  };

  const openOssTemplateExport = () => {
    setShareOpen(false);
    window.dispatchEvent(
      new CustomEvent("papr-chat-open", {
        detail: {
          message:
            `Export "${appTitle}" (${appId}) as an open-source community template using export_app_bundle, ` +
            `then help me prepare a PR for paprwork-community-apps on GitHub.`,
        },
      }),
    );
  };

  const openCommunityApps = () => {
    setShareOpen(false);
    window.dispatchEvent(new CustomEvent("papr-open-community-apps"));
  };

  const gatewayHost = import.meta.env.VITE_GATEWAY_HOST || "localhost";
  const gatewayPort = import.meta.env.VITE_GATEWAY_PORT || "18789";
  const localPreviewUrl = `http://${gatewayHost}:${gatewayPort}/apps/${appId}/index.html`;
  const isTrackCollaborator = cloudLineage?.mode === "track";
  const upstreamWebUrl =
    isTrackCollaborator && cloudLineage
      ? buildUpstreamPublishedWebUrl({
          sourceNamespaceId: cloudLineage.sourceNamespaceId,
          sourceSlug: cloudLineage.sourceSlug,
        })
      : null;
  const upstreamPreviewUrl =
    isTrackCollaborator && cloudLineage
      ? buildUpstreamCloudPreviewUrl({
          sourceNamespaceId: cloudLineage.sourceNamespaceId,
          sourceSlug: cloudLineage.sourceSlug,
        })
      : null;

  const webDisplayUrl = isTrackCollaborator
    ? upstreamWebUrl
    : cloud.publishedWebUrl ?? cloud.shareUrl;
  const previewDisplayUrl =
    viewMode === "published"
      ? isTrackCollaborator
        ? upstreamWebUrl
        : webDisplayUrl
      : localPreviewUrl;
  const copyUrl = isTrackCollaborator
    ? upstreamWebUrl
    : cloud.externalLinkUrl ?? cloud.loginUrl ?? webDisplayUrl;
  const showWebPanel = isWebLinkPermission(permission);
  const showCodePanel = isCodePermission(permission);
  const listsInCommunity = shouldListInCommunity(audience, cloud.live);
  const isFork = Boolean(cloudLineage);
  const showUpstreamBar = viewMode === "local" && isFork && cloudLineage;

  const showOwnerChangeRequests =
    cloud.live && isCodePermission(permission) && !isFork;

  const removeFromCommunity = () => {
    const nextPermission = permission === "edit" ? "edit" : "write";
    applySharing("link", nextPermission, false);
  };

  const takeOffWeb = () => {
    void cloud.unpublish();
    setShareOpen(false);
  };

  const statusDotClass = cloud.live
    ? cloud.refreshing
      ? "mini-app-publish-bar__dot mini-app-publish-bar__dot--pending"
      : "mini-app-publish-bar__dot mini-app-publish-bar__dot--live"
    : cloud.loading
      ? "mini-app-publish-bar__dot mini-app-publish-bar__dot--pending"
      : "mini-app-publish-bar__dot";

  const canOpenWebPreview = isTrackCollaborator
    ? !!upstreamPreviewUrl
    : cloud.live && !!cloud.publishedPreviewUrl;
  const webSyncTooltip = formatWebSyncStatusTooltip(webSyncStatus, {
    loading: webSyncLoading,
    error: webSyncError,
    refreshing: webSyncRefreshing,
  });
  const webSyncState = webSyncVisualState(webSyncStatus, {
    loading: webSyncLoading,
    error: webSyncError,
    pushing: webSyncPushing,
    refreshing: webSyncRefreshing,
  });
  const webSyncActionNeeded =
    webSyncStatus != null &&
    webSyncStatus.overall !== "synced" &&
    webSyncStatus.overall !== "disabled";
  const webSyncSpinning =
    webSyncPushing ||
    webSyncPulling ||
    (webSyncLoading && !webSyncStatus) ||
    webSyncState === "syncing";
  const shareSheetBusy = cloud.busy || webSyncPushing || Boolean(shareSyncNotice);
  const shareLinkReady =
    cloud.live &&
    webSyncStatus?.overall === "synced" &&
    !webSyncPushing &&
    !shareSyncNotice;

  const shareSelectionSummary = formatShareSelectionSummary(
    audience,
    permission,
    requireSignIn,
  );
  const shareSyncBanner = (() => {
    if (shareSyncNotice) {
      return { tone: "info" as const, message: shareSyncNotice };
    }
    if (cloud.busy) {
      return { tone: "info" as const, message: "Saving sharing settings…" };
    }
    if (webSyncPushing || webSyncStatus?.overall === "uploading") {
      return {
        tone: "info" as const,
        message: "Uploading app code and databases to the web…",
      };
    }
    if (cloud.live && webSyncStatus?.overall === "needs_sync") {
      return {
        tone: "warn" as const,
        message:
          "Sharing is saved, but the live link won't work until upload finishes.",
      };
    }
    if (shareLinkReady) {
      return { tone: "success" as const, message: "Your app is live and synced — the link is ready." };
    }
    return null;
  })();

  const handleWebPreviewClick = () => {
    setWebSyncPopoverOpen(false);
    if (canOpenWebPreview) {
      onViewModeChange("published");
    }
  };

  const handleWebSyncDotClick = () => {
    setWebSyncPopoverOpen((open) => !open);
  };

  const handlePublishClick = async () => {
    setShareSyncNotice("Publishing to the web…");
    try {
      await cloud.publish();
      setNeedsDesktopAck(false);
      setShareSyncNotice("Uploading app code and databases to the web…");
      await webSyncPushNow();
    } catch (err) {
      if (err instanceof CloudPublishBlockedError) {
        setCompatReport(err.compatibility);
        setNeedsDesktopAck(true);
      }
    } finally {
      setShareSyncNotice(null);
    }
  };

  const handleConfirmDesktopPublish = () => {
    setShareSyncNotice("Publishing to the web…");
    void cloud
      .publish({ acknowledgeDesktopOnly: true })
      .then(async () => {
        setNeedsDesktopAck(false);
        setShareSyncNotice("Uploading app code and databases to the web…");
        await webSyncPushNow();
      })
      .catch((err: unknown) => {
        if (err instanceof CloudPublishBlockedError) {
          setCompatReport(err.compatibility);
          setNeedsDesktopAck(true);
        }
      })
      .finally(() => {
        setShareSyncNotice(null);
      });
  };

  return (
    <>
      <div className="mini-app-publish-bar">
        <div className="mini-app-publish-bar__left">
          <span className={statusDotClass} aria-hidden />
          <div className="mini-app-publish-bar__meta">
            <span className="mini-app-publish-bar__title">{appTitle}</span>
            <CloudCompatibilityBadge
              report={compatReport ?? cloud.compatibility}
              loading={compatLoading && !compatReport && !cloud.compatibility}
            />
            <span className="mini-app-publish-bar__status">
              {cloud.loading && !cloud.live
                ? "Checking…"
                : `${cloud.live ? "Live" : "Draft"} · ${cloud.statusLabel}`}
              {cloud.refreshing && cloud.live ? " · updating" : null}
              {isFork && cloudLineage && !showUpstreamBar
                ? ` · ${cloudLineage.mode === "track" ? "Tracking" : "Fork"} ${cloudLineage.sourceSlug}`
                : null}
            </span>
          </div>

          {showUpstreamBar ? (
            <CloudUpstreamBar
              appTitle={appTitle}
              lineage={{
                mode: cloudLineage.mode,
                sourceAppId: cloudLineage.sourceAppId,
                sourceSlug: cloudLineage.sourceSlug,
                sourceNamespaceId: cloudLineage.sourceNamespaceId,
                installedAppId: appId,
                lastSyncedAt: cloudLineage.lastSyncedAt,
              }}
              lastSyncedAt={lastSyncedAt}
              busy={cloud.busy}
              onLastSyncedAtChange={setLastSyncedAt}
              onTrackPullComplete={() => {
                onTrackPullComplete?.();
              }}
            />
          ) : null}

        </div>

        {workspaceMode === "preview" ? (
          <div
            ref={webSyncAnchorRef}
            className="mini-app-publish-bar__segment mini-app-publish-bar__segment--with-sync"
            role="group"
            aria-label="Preview mode"
          >
            <button
              type="button"
              className={
                viewMode === "local"
                  ? "mini-app-publish-bar__segment-btn mini-app-publish-bar__segment-btn--active"
                  : "mini-app-publish-bar__segment-btn"
              }
              onClick={() => {
                setWebSyncPopoverOpen(false);
                onViewModeChange("local");
              }}
            >
              Local
            </button>
            <div
              className={
                viewMode === "published"
                  ? "mini-app-publish-bar__web-option mini-app-publish-bar__web-option--active"
                  : "mini-app-publish-bar__web-option"
              }
            >
              <button
                type="button"
                className="mini-app-publish-bar__segment-btn"
                disabled={!canOpenWebPreview}
                title={
                  canOpenWebPreview
                    ? isTrackCollaborator
                      ? "Preview the team's live web version (publisher)"
                      : "Preview the live web version"
                    : "Publish to the web first"
                }
                onClick={handleWebPreviewClick}
              >
                Web
              </button>
              <WebSyncStatusDot
                state={webSyncState}
                spinning={webSyncSpinning}
                tooltip={webSyncTooltip}
                popoverOpen={webSyncPopoverOpen}
                onClick={handleWebSyncDotClick}
              />
            </div>
            {webSyncPopoverOpen && webSyncPopoverPos
              ? createPortal(
                  <WebSyncPopover
                    popoverRef={webSyncPopoverRef}
                    className="mini-app-publish-bar__sync-popover--portal"
                    style={{
                      position: "fixed",
                      top: webSyncPopoverPos.top,
                      left: webSyncPopoverPos.left,
                      zIndex: 10000,
                    }}
                    status={webSyncStatus}
                    loading={webSyncLoading && !webSyncStatus}
                    error={webSyncError}
                    pushing={webSyncPushing}
                    pulling={webSyncPulling}
                    syncActionNeeded={webSyncActionNeeded}
                    onPushNow={() => void webSyncPushNow()}
                    onPullUpdates={() => void webSyncPullUpdates()}
                  />,
                  document.body,
                )
              : null}
          </div>
        ) : null}

        {workspaceMode === "preview" && previewDisplayUrl ? (
          <div className="mini-app-publish-bar__url-row">
            <span className="mini-app-publish-bar__url" title={previewDisplayUrl}>
              {previewDisplayUrl}
            </span>
            <button
              type="button"
              className="mini-app-publish-bar__icon-button"
              title={viewMode === "published" ? "Refresh web preview" : "Refresh local preview"}
              aria-label="Refresh preview"
              onClick={() => onRefreshPreview?.()}
            >
              <RefreshIcon />
            </button>
            <button
              type="button"
              className="mini-app-publish-bar__icon-button"
              title="Open in browser"
              aria-label="Open in browser"
              onClick={() => void cloud.openInBrowser(previewDisplayUrl)}
            >
              <OpenExternalIcon />
            </button>
            <button
              type="button"
              className="mini-app-publish-bar__icon-button"
              title="Copy link"
              aria-label="Copy link"
              onClick={() => void cloud.copyLink(previewDisplayUrl)}
            >
              <CopyIcon />
            </button>
          </div>
        ) : null}

        <div className="mini-app-publish-bar__actions">
          {cloud.toast ? (
            <span className="mini-app-publish-bar__toast">{cloud.toast}</span>
          ) : null}
          {cloud.error ? (
            <span className="mini-app-publish-bar__error">{cloud.error}</span>
          ) : null}

          <AppWorkspaceMenu
            mode={workspaceMode}
            onModeChange={onWorkspaceModeChange}
            align="right"
          />

          <button
            type="button"
            className="mini-app-publish-bar__button mini-app-publish-bar__button--primary"
            disabled={cloud.busy}
            onClick={() => setShareOpen(true)}
          >
            Share
          </button>
        </div>
      </div>

      {shareOpen ? (
        <ShareSheet title={`Share “${appTitle}”`} onClose={() => setShareOpen(false)}>

          <div className="share-sheet__panel">
            {shareSyncBanner ? (
              <div
                className={`share-sheet__sync-banner share-sheet__sync-banner--${shareSyncBanner.tone}`}
                role="status"
              >
                <p>{shareSyncBanner.message}</p>
                {shareSheetBusy ? (
                  <p className="share-sheet__sync-banner-selection">
                    <span className="share-sheet__sync-banner-selection-label">
                      Your selection
                    </span>
                    {shareSelectionSummary}
                  </p>
                ) : null}
                {shareSyncBanner.tone === "warn" ? (
                  <button
                    type="button"
                    className="share-sheet__sync-banner-btn"
                    disabled={shareSheetBusy}
                    onClick={() => void webSyncPushNow()}
                  >
                    {webSyncPushing ? "Uploading…" : "Upload now"}
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* Share link at the top - most prominent */}
            {cloud.live && (copyUrl || webDisplayUrl) ? (
              <div className="share-sheet__link-section">
                {!shareLinkReady ? (
                  <p className="share-sheet__link-hint">
                    The link below may show &quot;not found&quot; until upload completes.
                  </p>
                ) : null}
                <div className="share-sheet__url-field">
                  <input
                    className="share-sheet__url-input"
                    readOnly
                    value={copyUrl ?? webDisplayUrl ?? ""}
                    aria-label="Share link"
                  />
                  <button
                    type="button"
                    className="share-sheet__icon-btn"
                    title="Copy link"
                    aria-label="Copy link"
                    onClick={() => void cloud.copyLink(copyUrl ?? webDisplayUrl)}
                  >
                    <CopyIcon />
                  </button>
                  <button
                    type="button"
                    className="share-sheet__icon-btn"
                    title="Open in browser"
                    aria-label="Open in browser"
                    onClick={() => void cloud.openInBrowser(webDisplayUrl)}
                  >
                    <OpenExternalIcon />
                  </button>
                </div>
              </div>
            ) : null}

            {isFork ? (
              <div className="share-sheet__notice share-sheet__notice--info">
                <p>
                  <strong>Publish your copy</strong> — this puts <em>your</em> local
                  fork on the web. It does not change the team&apos;s shared upstream
                  app.
                </p>
              </div>
            ) : null}

            <fieldset
              className={
                shareSheetBusy
                  ? "share-sheet__fieldset share-sheet__fieldset--locked"
                  : "share-sheet__fieldset"
              }
            >
              <legend className="share-sheet__legend">
                {isFork ? "Who can access your copy" : "Who can access"}
              </legend>
              <ul className="share-sheet__list">
                {ACCESS_OPTIONS.map((option) => (
                  <li key={option.value}>
                    <label
                      className={
                        audience === option.value
                          ? "share-sheet__row share-sheet__row--selected"
                          : "share-sheet__row"
                      }
                    >
                      <input
                        type="radio"
                        name={`access-${appId}`}
                        checked={audience === option.value}
                        onChange={() => {
                          if (shareSheetBusy) return;
                          pickAudience(option.value);
                        }}
                      />
                      <span className="share-sheet__row-text">
                        <span className="share-sheet__row-label">{option.label}</span>
                        <span className="share-sheet__row-desc">{option.description}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              
              {/* Sign-in toggle for link sharing */}
              {audience === "link" ? (
                <div className="share-sheet__toggle-row">
                  <label className="share-sheet__toggle-label">
                    <input
                      type="checkbox"
                      checked={requireSignIn}
                      onChange={(event) => {
                        if (shareSheetBusy) return;
                        void applySharing(audience, permission, event.target.checked);
                      }}
                    />
                    <span>Require Papr sign-in</span>
                  </label>
                  <p className="share-sheet__toggle-hint">
                    {requireSignIn 
                      ? "Viewers must sign in with a Papr account"
                      : "Anyone with the link can open it without an account"}
                  </p>
                </div>
              ) : null}
            </fieldset>

            {audience !== "private" ? (
              <fieldset
                className={
                  shareSheetBusy
                    ? "share-sheet__fieldset share-sheet__fieldset--locked"
                    : "share-sheet__fieldset"
                }
              >
                <legend className="share-sheet__legend">What can they do</legend>
                <ul className="share-sheet__list">
                  {PERMISSION_OPTIONS.map((option) => {
                    const available = isPermissionAvailable(audience, option.value);
                    const selected = permission === option.value;
                    return (
                      <li key={option.value}>
                        <label
                          className={
                            !available
                              ? "share-sheet__row share-sheet__row--disabled"
                              : selected
                                ? "share-sheet__row share-sheet__row--selected"
                                : "share-sheet__row"
                          }
                        >
                          <input
                            type="radio"
                            name={`permission-${appId}`}
                            checked={selected}
                            onChange={() => {
                              if (shareSheetBusy || !available) return;
                              pickPermission(option.value);
                            }}
                          />
                          <span className="share-sheet__row-text">
                            <span className="share-sheet__row-label">{option.label}</span>
                            <span className="share-sheet__row-desc">
                              {option.description}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            ) : null}

            {/* Publish button if not live */}
            {!cloud.live ? (
              <div className="share-sheet__notice share-sheet__notice--info">
                <p>
                  {isFork
                    ? "Publish your copy on the web to get a shareable link for this fork."
                    : "Publish your app on the web first to get a shareable link."}
                </p>
                <button
                  type="button"
                  className="share-sheet__primary-btn"
                  disabled={shareSheetBusy || cloud.loading}
                  onClick={() => void handlePublishClick()}
                >
                  {isFork ? "Publish your copy" : "Publish on Web"}
                </button>
              </div>
            ) : null}

            {isFork && cloudLineage ? (
              <CloudContributeBackPanel
                appTitle={appTitle}
                lineage={{
                  mode: cloudLineage.mode,
                  sourceAppId: cloudLineage.sourceAppId,
                  sourceSlug: cloudLineage.sourceSlug,
                  sourceNamespaceId: cloudLineage.sourceNamespaceId,
                  installedAppId: appId,
                }}
                busy={cloud.busy}
              />
            ) : null}

            {/* API Credentials - simplified */}
            {cloud.live && !isFork ? (
              <CloudAppCredentialsPanel
                appId={appId}
                appTitle={appTitle}
                busy={cloud.busy}
              />
            ) : null}

            {cloud.live && listsInCommunity ? (
              <div className="share-sheet__section">
                <p className="share-sheet__notice share-sheet__notice--success">
                  Listed in <strong>Community Apps</strong> — others can discover and open
                  this app
                </p>
                <button
                  type="button"
                  className="share-sheet__secondary-btn"
                  disabled={cloud.busy}
                  onClick={removeFromCommunity}
                >
                  Share via link only
                </button>
              </div>
            ) : null}

            {/* Code access - simplified */}
            {showCodePanel && cloud.live ? (
              <div className="share-sheet__section">
                <p className="share-sheet__section-title">Code access</p>
                <p className="share-sheet__section-desc">
                  Others can install this app's source into their Paprwork to customize or contribute changes back.
                </p>

                {showOwnerChangeRequests ? (
                  <CloudChangeRequestsPanel sourceAppId={appId} busy={cloud.busy} />
                ) : null}
              </div>
            ) : null}

            {/* Unpublish */}
            {cloud.live && !isFork ? (
              <div className="share-sheet__section">
                <p className="share-sheet__section-title">Take off the web</p>
                <p className="share-sheet__section-desc">
                  Unpublish completely — removes the live URL and Community listing.
                </p>
                <button
                  type="button"
                  className="share-sheet__danger-btn"
                  disabled={cloud.busy}
                  onClick={takeOffWeb}
                >
                  Unpublish
                </button>
              </div>
            ) : null}

            {/* Cloud compatibility info - only show if blocking publish */}
            {needsDesktopAck ? (
              <CloudCompatibilityPanel
                report={compatReport ?? cloud.compatibility}
                loading={compatLoading}
                showConfirm={needsDesktopAck}
                confirmBusy={cloud.busy}
                onConfirmPublish={handleConfirmDesktopPublish}
              />
            ) : null}
          </div>
        </ShareSheet>
      ) : null}
    </>
  );
}
