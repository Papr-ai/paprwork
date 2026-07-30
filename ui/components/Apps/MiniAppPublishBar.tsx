/**
 * MiniAppPublishBar — publish, share, preview mode controls.
 */

import React, { useEffect, useRef, useState } from "react";
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
  formatLastSyncedAt,
  formatTrackSyncSummary,
  pullTrackUpstream as fetchTrackUpstream,
} from "../../utils/cloudTrackSyncApi";
import { CloudChangeRequestsPanel } from "./CloudChangeRequestsPanel";
import { CloudContributeBackPanel } from "./CloudContributeBackPanel";
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
}: MiniAppPublishBarProps) {
  const [shareOpen, setShareOpen] = useState(false);
  const [audience, setAudience] = useState<ShareAudience>("private");
  const [permission, setPermission] = useState<SharePermission>("write");
  const [requireSignIn, setRequireSignIn] = useState(true);
  const [trackPulling, setTrackPulling] = useState(false);
  const [trackPullNotice, setTrackPullNotice] = useState<string | null>(null);
  const [trackPullError, setTrackPullError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | undefined>(
    cloudLineage?.lastSyncedAt,
  );
  const [webSyncPopoverOpen, setWebSyncPopoverOpen] = useState(false);
  const webSyncAnchorRef = useRef<HTMLDivElement>(null);
  const [compatReport, setCompatReport] = useState<CloudCompatibilityReport | null>(
    cloud.compatibility,
  );
  const [compatLoading, setCompatLoading] = useState(false);
  const [needsDesktopAck, setNeedsDesktopAck] = useState(false);

  const { status: webSyncStatus, loading: webSyncLoading, refreshing: webSyncRefreshing, pushing: webSyncPushing, error: webSyncError, pushNow: webSyncPushNow } =
    useAppCloudSyncStatus(appId, { enabled: workspaceMode === "preview" });

  useEffect(() => {
    setCompatReport(cloud.compatibility);
  }, [cloud.compatibility]);

  useEffect(() => {
    if (!shareOpen) {
      setNeedsDesktopAck(false);
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
    if (!shareOpen) return;
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

  useEffect(() => {
    if (!webSyncPopoverOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!webSyncAnchorRef.current?.contains(event.target as Node)) {
        setWebSyncPopoverOpen(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWebSyncPopoverOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [webSyncPopoverOpen]);

  useEffect(() => {
    if (workspaceMode !== "preview") {
      setWebSyncPopoverOpen(false);
    }
  }, [workspaceMode]);

  const applySharing = (
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
    void cloud.updateSharing(model);
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

  const publishedUrl = cloud.publishedPreviewUrl;
  const copyUrl = cloud.externalLinkUrl ?? cloud.loginUrl ?? publishedUrl;
  const showWebPanel = isWebLinkPermission(permission);
  const showCodePanel = isCodePermission(permission);
  const listsInCommunity = shouldListInCommunity(audience, cloud.live);
  const isFork = Boolean(cloudLineage);
  const isTrackMode = cloudLineage?.mode === "track";
  const showTrackPullBar = viewMode === "local" && isTrackMode;
  const lastSyncedLabel = formatLastSyncedAt(lastSyncedAt);

  const handlePullTrackUpstream = async () => {
    setTrackPulling(true);
    setTrackPullError(null);
    setTrackPullNotice(null);
    try {
      const result = await fetchTrackUpstream(appId);
      setLastSyncedAt(result.lastSyncedAt);
      setTrackPullNotice(formatTrackSyncSummary(result));
      onTrackPullComplete?.();
    } catch (err) {
      setTrackPullError((err as Error).message.slice(0, 120));
    } finally {
      setTrackPulling(false);
    }
  };

  useEffect(() => {
    if (!trackPullNotice) return;
    const timer = setTimeout(() => setTrackPullNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [trackPullNotice]);

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

  const canOpenWebPreview = cloud.live && !!publishedUrl;
  const webSyncLoadingState = webSyncLoading || webSyncRefreshing;
  const webSyncTooltip = formatWebSyncStatusTooltip(webSyncStatus, {
    loading: webSyncLoadingState,
    error: webSyncError,
  });
  const webSyncState = webSyncVisualState(webSyncStatus, {
    loading: webSyncLoadingState,
    error: webSyncError,
    pushing: webSyncPushing,
    refreshing: webSyncRefreshing,
  });
  const webSyncActionNeeded =
    webSyncStatus != null &&
    webSyncStatus.overall !== "synced" &&
    webSyncStatus.overall !== "disabled";
  const webSyncSpinning = webSyncPushing || webSyncState === "syncing";

  const handleWebPreviewClick = () => {
    setWebSyncPopoverOpen(false);
    if (canOpenWebPreview) {
      onViewModeChange("published");
    }
  };

  const handleWebSyncDotClick = () => {
    if (canOpenWebPreview) {
      onViewModeChange("published");
    }
    setWebSyncPopoverOpen(true);
  };

  const handlePublishClick = async () => {
    try {
      await cloud.publish();
      setNeedsDesktopAck(false);
    } catch (err) {
      if (err instanceof CloudPublishBlockedError) {
        setCompatReport(err.compatibility);
        setNeedsDesktopAck(true);
      }
    }
  };

  const handleConfirmDesktopPublish = () => {
    void cloud
      .publish({ acknowledgeDesktopOnly: true })
      .then(() => setNeedsDesktopAck(false))
      .catch((err: unknown) => {
        if (err instanceof CloudPublishBlockedError) {
          setCompatReport(err.compatibility);
          setNeedsDesktopAck(true);
        }
      });
  };

  return (
    <>
      <div className="mini-app-publish-bar">
        <div className="mini-app-publish-bar__left">
          <span className={statusDotClass} aria-hidden />
          <div className="mini-app-publish-bar__meta">
            <span className="mini-app-publish-bar__title">{appTitle}</span>
            <span className="mini-app-publish-bar__status">
              {cloud.loading && !cloud.live
                ? "Checking web status…"
                : `${cloud.live ? "Live on web" : "Not on web yet"} · ${cloud.statusLabel}`}
              {cloud.refreshing && cloud.live ? " · updating" : null}
              {showTrackPullBar && cloudLineage
                ? ` · Tracking ${cloudLineage.sourceSlug}`
                : null}
            </span>
            <CloudCompatibilityBadge
              report={compatReport ?? cloud.compatibility}
              loading={compatLoading && !compatReport && !cloud.compatibility}
            />
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
                      ? "Preview the live web version"
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
              {webSyncPopoverOpen && webSyncStatus ? (
                <WebSyncPopover
                  status={webSyncStatus}
                  error={webSyncError}
                  pushing={webSyncPushing}
                  syncActionNeeded={webSyncActionNeeded}
                  onPushNow={() => void webSyncPushNow()}
                />
              ) : null}
            </div>
          ) : null}

          {showTrackPullBar ? (
            <div className="mini-app-publish-bar__track-pull">
              <div className="mini-app-publish-bar__track-pull-copy">
                <span className="mini-app-publish-bar__track-pull-label">
                  Publisher updates
                </span>
                <span className="mini-app-publish-bar__track-pull-meta">
                  {lastSyncedLabel
                    ? `Last pulled ${lastSyncedLabel}`
                    : "Not pulled yet"}
                </span>
              </div>
              <button
                type="button"
                className="mini-app-publish-bar__button mini-app-publish-bar__button--track"
                disabled={trackPulling || cloud.busy}
                title="Download the publisher's latest code into your local copy"
                onClick={() => void handlePullTrackUpstream()}
              >
                {trackPulling ? "Pulling…" : "Pull latest"}
              </button>
            </div>
          ) : null}

          {publishedUrl ? (
            <div className="mini-app-publish-bar__url-row">
              <span className="mini-app-publish-bar__url" title={publishedUrl}>
                {publishedUrl}
              </span>
              <button
                type="button"
                className="mini-app-publish-bar__icon-button"
                title="Open in browser"
                aria-label="Open in browser"
                onClick={() => void cloud.openInBrowser(publishedUrl)}
              >
                <OpenExternalIcon />
              </button>
              <button
                type="button"
                className="mini-app-publish-bar__icon-button"
                title="Copy link"
                aria-label="Copy link"
                onClick={() => void cloud.copyLink(publishedUrl)}
              >
                <CopyIcon />
              </button>
            </div>
          ) : null}
        </div>

        <div className="mini-app-publish-bar__actions">
          {trackPullNotice ? (
            <span className="mini-app-publish-bar__toast">{trackPullNotice}</span>
          ) : null}
          {trackPullError ? (
            <span className="mini-app-publish-bar__error">{trackPullError}</span>
          ) : null}
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
            {/* Share link at the top - most prominent */}
            {cloud.live && (copyUrl || publishedUrl) ? (
              <div className="share-sheet__link-section">
                <div className="share-sheet__url-field">
                  <input
                    className="share-sheet__url-input"
                    readOnly
                    value={copyUrl ?? publishedUrl ?? ""}
                    aria-label="Share link"
                  />
                  <button
                    type="button"
                    className="share-sheet__icon-btn"
                    title="Copy link"
                    aria-label="Copy link"
                    onClick={() => void cloud.copyLink(copyUrl ?? publishedUrl)}
                  >
                    <CopyIcon />
                  </button>
                  <button
                    type="button"
                    className="share-sheet__icon-btn"
                    title="Open in browser"
                    aria-label="Open in browser"
                    onClick={() => void cloud.openInBrowser(publishedUrl)}
                  >
                    <OpenExternalIcon />
                  </button>
                </div>
              </div>
            ) : null}

            <fieldset className="share-sheet__fieldset" disabled={cloud.busy}>
              <legend className="share-sheet__legend">Who can access</legend>
              <ul className="share-sheet__list">
                {ACCESS_OPTIONS.map((option) => (
                  <li key={option.value}>
                    <label className="share-sheet__row">
                      <input
                        type="radio"
                        name={`access-${appId}`}
                        checked={audience === option.value}
                        onChange={() => pickAudience(option.value)}
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
                      disabled={cloud.busy}
                      onChange={(event) => {
                        applySharing(audience, permission, event.target.checked);
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
              <fieldset className="share-sheet__fieldset" disabled={cloud.busy}>
                <legend className="share-sheet__legend">What can they do</legend>
                <ul className="share-sheet__list">
                  {PERMISSION_OPTIONS.map((option) => {
                    const available = isPermissionAvailable(audience, option.value);
                    return (
                      <li key={option.value}>
                        <label
                          className={
                            available
                              ? "share-sheet__row"
                              : "share-sheet__row share-sheet__row--disabled"
                          }
                        >
                          <input
                            type="radio"
                            name={`permission-${appId}`}
                            checked={permission === option.value}
                            disabled={!available}
                            onChange={() => pickPermission(option.value)}
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
                <p>Publish your app on the web first to get a shareable link.</p>
                <button
                  type="button"
                  className="share-sheet__primary-btn"
                  disabled={cloud.busy || cloud.loading}
                  onClick={() => void handlePublishClick()}
                >
                  Publish on Web
                </button>
              </div>
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

            {/* Fork/contribute panel */}
            {isFork && cloudLineage ? (
              <CloudContributeBackPanel
                appTitle={appTitle}
                lineage={{
                  mode: cloudLineage.mode,
                  sourceAppId: cloudLineage.sourceAppId,
                  sourceSlug: cloudLineage.sourceSlug,
                  sourceNamespaceId: cloudLineage.sourceNamespaceId,
                  installedAppId: appId,
                  lastSyncedAt: cloudLineage.lastSyncedAt,
                }}
                busy={cloud.busy}
                onTrackPullComplete={(result) => {
                  setLastSyncedAt(result.lastSyncedAt);
                  onTrackPullComplete?.();
                }}
              />
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
