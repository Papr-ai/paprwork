/**
 * MiniAppPublishBar — publish, share, preview mode controls.
 */

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { useCloudPublish } from "../../hooks/useCloudPublish";
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
import { AppCloudSyncChip } from "./AppCloudSyncChip";
import { AppWorkspaceMenu } from "./AppWorkspaceMenu";
import type { AppWorkspaceMode } from "../../hooks/useAppWorkspace";
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
    label: "My team",
    description: "People in your Papr workspace — sign in required (needed for agent jobs)",
  },
  {
    value: "public",
    label: "Anyone on the web",
    description: "Public page on apps.papr.ai",
  },
  {
    value: "link",
    label: "People with invite link",
    description: "Secret link — no Papr account needed",
  },
];

const PERMISSION_OPTIONS: {
  value: SharePermission;
  label: string;
  description: string;
}[] = [
  {
    value: "read",
    label: "View only",
    description: "Open your live app and read data — no edits",
  },
  {
    value: "write",
    label: "Use the app",
    description: "Fill forms and use edit buttons in your live app",
  },
  {
    value: "edit",
    label: "Edit the code",
    description: "Install into Paprwork — fork, customize, or send changes back",
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
  const [permission, setPermission] = useState<SharePermission>("read");
  const [trackPulling, setTrackPulling] = useState(false);
  const [trackPullNotice, setTrackPullNotice] = useState<string | null>(null);
  const [trackPullError, setTrackPullError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | undefined>(
    cloudLineage?.lastSyncedAt,
  );

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
  }, [shareOpen, cloud.loginAccess, cloud.externalLink, cloud.codeAccess]);

  useEffect(() => {
    if (!shareOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShareOpen(false);
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [shareOpen]);

  const applySharing = (nextAudience: ShareAudience, nextPermission: SharePermission) => {
    setAudience(nextAudience);
    setPermission(nextPermission);
    const model: ShareAudienceModel = {
      audience: nextAudience,
      permission: nextPermission,
    };
    if (!isPermissionAvailable(nextAudience, nextPermission)) return;
    void cloud.updateSharing(model);
  };

  const pickAudience = (nextAudience: ShareAudience) => {
    let nextPermission = permission;
    if (!isPermissionAvailable(nextAudience, nextPermission)) {
      nextPermission = "read";
    }
    applySharing(nextAudience, nextPermission);
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
    applySharing("private", "read");
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
          </div>

          {workspaceMode === "preview" ? (
            <div className="mini-app-publish-bar__segment" role="group" aria-label="Preview mode">
              <button
                type="button"
                className={
                  viewMode === "local"
                    ? "mini-app-publish-bar__segment-btn mini-app-publish-bar__segment-btn--active"
                    : "mini-app-publish-bar__segment-btn"
                }
                onClick={() => onViewModeChange("local")}
              >
                Local
              </button>
              <button
                type="button"
                className={
                  viewMode === "published"
                    ? "mini-app-publish-bar__segment-btn mini-app-publish-bar__segment-btn--active"
                    : "mini-app-publish-bar__segment-btn"
                }
                disabled={!cloud.live || !publishedUrl}
                onClick={() => onViewModeChange("published")}
              >
                Web
              </button>
            </div>
          ) : null}

          <AppCloudSyncChip appId={appId} />

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
            </fieldset>

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
                            {!available && option.value === "write"
                              ? " — not available for public pages"
                              : null}
                            {!available && option.value === "edit"
                              ? " — choose team, public, or invite link"
                              : null}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>

            {audience === "link" ? (
              <div className="share-sheet__notice share-sheet__notice--info">
                <p>
                  Invite links open without a Papr account. Buttons that run{" "}
                  <strong>agent jobs</strong> (AI tasks) still require Papr sign-in — use{" "}
                  <strong>My team</strong> or <strong>Only me</strong> instead, or ask visitors
                  to sign in at{" "}
                  <code>{cloud.appsHost}/auth/login</code> before using those features.
                </p>
              </div>
            ) : null}

            {showWebPanel ? (
              <div className="share-sheet__section">
                <p className="share-sheet__section-title">Live web link</p>
                <p className="share-sheet__section-desc">
                  Opens your app on <strong>{cloud.appsHost}</strong>. Changes they make
                  stay in your cloud data — not a separate copy.
                </p>

                {!cloud.live ? (
                  <div className="share-sheet__notice share-sheet__notice--info">
                    <p>Put your app on the web first, then copy the link.</p>
                    <button
                      type="button"
                      className="share-sheet__primary-btn"
                      disabled={cloud.busy || cloud.loading}
                      onClick={() => void cloud.publish()}
                    >
                      Put on web
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="share-sheet__url-field">
                      <input
                        className="share-sheet__url-input"
                        readOnly
                        value={copyUrl ?? publishedUrl ?? ""}
                        aria-label="Web link"
                      />
                      <button
                        type="button"
                        className="share-sheet__icon-btn"
                        title="Copy link"
                        aria-label="Copy link"
                        disabled={!copyUrl && !publishedUrl}
                        onClick={() => void cloud.copyLink(copyUrl ?? publishedUrl)}
                      >
                        <CopyIcon />
                      </button>
                      <button
                        type="button"
                        className="share-sheet__icon-btn"
                        title="Open in browser"
                        aria-label="Open in browser"
                        disabled={!publishedUrl}
                        onClick={() => void cloud.openInBrowser(publishedUrl)}
                      >
                        <OpenExternalIcon />
                      </button>
                    </div>
                    <button
                      type="button"
                      className="share-sheet__secondary-btn"
                      disabled={cloud.busy}
                      onClick={() => void cloud.publish()}
                    >
                      Update web version
                    </button>
                  </>
                )}
              </div>
            ) : null}

            {showCodePanel ? (
              <div className="share-sheet__section">
                <p className="share-sheet__section-title">Install in Paprwork</p>
                <p className="share-sheet__section-desc">
                  Source stays in your private <strong>papr-work</strong> repo. Others
                  install into their Paprwork — they can fork their own copy or send
                  changes back for your approval.
                </p>

                {!cloud.live ? (
                  <div className="share-sheet__notice share-sheet__notice--info">
                    <p>Publish to the web first so Papr can serve install access.</p>
                    <button
                      type="button"
                      className="share-sheet__primary-btn"
                      disabled={cloud.busy || cloud.loading}
                      onClick={() => void cloud.publish()}
                    >
                      Put on web
                    </button>
                  </div>
                ) : (
                  <>
                    {listsInCommunity ? (
                      <>
                        <p className="share-sheet__notice share-sheet__notice--success">
                          This app appears in <strong>Community Apps</strong> for discovery.
                          Code stays private on papr-work — users install through Papr.
                        </p>
                        <button
                          type="button"
                          className="share-sheet__danger-btn"
                          disabled={cloud.busy}
                          onClick={removeFromCommunity}
                        >
                          Remove from Community
                        </button>
                        <p className="share-sheet__footnote">
                          Sets access to <strong>Only me</strong> — still on the web for you, hidden
                          from the Community catalog.
                        </p>
                      </>
                    ) : null}

                    {showOwnerChangeRequests ? (
                      <CloudChangeRequestsPanel
                        sourceAppId={appId}
                        busy={cloud.busy}
                      />
                    ) : null}

                    <div className="share-sheet__community-actions">
                      <button
                        type="button"
                        className="share-sheet__secondary-btn"
                        onClick={openCloudInstallHelp}
                      >
                        How install works
                      </button>
                      <button
                        type="button"
                        className="share-sheet__link-btn"
                        onClick={openCommunityApps}
                      >
                        Browse Community Apps →
                      </button>
                    </div>

                    <div className="share-sheet__community">
                      <p className="share-sheet__community-title">Open-source template (optional)</p>
                      <p className="share-sheet__community-desc">
                        For users without Papr Cloud, submit a bundle to the public{" "}
                        <strong>paprwork-community-apps</strong> repo on GitHub.
                      </p>
                      <button
                        type="button"
                        className="share-sheet__secondary-btn"
                        onClick={openOssTemplateExport}
                      >
                        Prepare GitHub template
                      </button>
                    </div>
                  </>
                )}
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
                  lastSyncedAt: cloudLineage.lastSyncedAt,
                }}
                busy={cloud.busy}
                onTrackPullComplete={(result) => {
                  setLastSyncedAt(result.lastSyncedAt);
                  onTrackPullComplete?.();
                }}
              />
            ) : null}

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
                  Unpublish from Papr Cloud
                </button>
              </div>
            ) : null}

            {cloud.live && !isFork ? (
              <CloudAppCredentialsPanel
                appId={appId}
                appTitle={appTitle}
                busy={cloud.busy}
              />
            ) : null}

            {showWebPanel && !showCodePanel ? (
              <p className="share-sheet__footnote">
                Want them to install and customize source? Choose{" "}
                <button
                  type="button"
                  className="share-sheet__inline-link"
                  onClick={() => pickPermission("edit")}
                >
                  Edit the code
                </button>
                .
              </p>
            ) : null}
          </div>
        </ShareSheet>
      ) : null}
    </>
  );
}
