/**
 * MiniAppPublishBar — publish, share, preview mode controls.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { useCloudPublish } from "../../hooks/useCloudPublish";
import { useAppCloudSyncStatus } from "../../hooks/useAppCloudSyncStatus";
import {
  formatWebSyncStatusTooltip,
  resolvePublishBarStatus,
  resolvePublishBarChipForForkUpstream,
  resolvePublishBarChipLabel,
  resolvePublishBarPrimaryAction,
  webSyncVisualState,
} from "../../utils/appCloudSyncStatus";
import { pullTrackUpstream } from "../../utils/cloudTrackSyncApi";
import {
  resolveEffectiveAutoUpload,
} from "../../utils/appUploadMode";
import { audienceModelNeedsInitialCodeUpload } from "../../utils/cloudPublishRouting";
import {
  SharePeoplePicker,
  type SharePeopleMember,
} from "./SharePeoplePicker";
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
import { useIncomingCloudChangeRequests } from "../../hooks/useIncomingCloudChangeRequests";
import { CloudChangeRequestsPanel } from "./CloudChangeRequestsPanel";
import { CloudContributeBackPanel } from "./CloudContributeBackPanel";
import { CloudUpstreamBar } from "./CloudUpstreamBar";
import { CloudAppCredentialsPanel } from "./CloudAppCredentialsPanel";
import { PublishBarOverflowMenu } from "./PublishBarOverflowMenu";
import { AppWorkspacePanelMenu } from "./AppWorkspacePanelMenu";
import {
  WebSyncPopover,
  WebSyncStatusDot,
  ShareAudienceIcon,
  buildGenericSyncAgentPrompt,
  webSyncPushButtonLabel,
} from "./WebSyncPopover";
import { openCloudSyncAgentChat } from "../../utils/openCloudSyncAgentChat";
import type { AppWorkspaceMode, AppWorkspacePanel } from "../../hooks/useAppWorkspace";
import {
  CloudCompatibilityBadge,
  CloudCompatibilityPanel,
} from "./CloudCompatibilityPanel";
import { PaprCloudRequirementsPanel } from "../common/PaprCloudRequirementsPanel";
import { requestPaprCloudFeature } from "../../stores/paprCloudFeatureStore";
import {
  CloudPublishBlockedError,
  fetchCloudCompatibility,
  fetchCloudPublishReadiness,
} from "../../utils/cloudPublishApi";
import type { CloudCompatibilityReport } from "../../src/core/types/cloudAppCompatibility";
import type { CloudPublishReadinessReport } from "../../src/core/types/cloudAppDependencies";
import { CloudPublishDependenciesPanel } from "./CloudPublishDependenciesPanel";
import { PreviewUrlRow } from "./PreviewUrlRow";
import { PublishBarErrorNotice } from "./PublishBarErrorNotice";
import "./MiniAppPublishBar.css";
import "./AppWorkspaceMenu.css";
import "./AppWorkspacePanelMenu.css";

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
  workspacePanel: AppWorkspacePanel;
  onWorkspacePanelChange: (panel: AppWorkspacePanel) => void;
  linkedJobCount?: number;
  onTrackPullComplete?: () => void;
  onRefreshPreview?: () => void;
  /** False when preview tab is backgrounded (LRU keep-alive). Pauses sync polling. */
  previewTabVisible?: boolean;
  /** True after the local preview iframe shell has loaded — sync checks wait for this. */
  previewShellLoaded?: boolean;
  onOpenDependencyApp?: (appId: string, title?: string) => void;
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
    value: "people",
    label: "Specific people",
    description: "Only the teammates you @mention — sign in required",
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
    description: "Install the app, then send changes",
  },
];

function formatShareSelectionSummary(
  audience: ShareAudience,
  permission: SharePermission,
  requireSignIn: boolean,
  perUserIsolation: boolean,
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
  if (audience === "link" || audience === "public") {
    parts.push(requireSignIn ? "Sign-in required" : "No sign-in required");
  }
  if (
    perUserIsolation &&
    (audience === "team" ||
      ((audience === "link" || audience === "public") && requireSignIn))
  ) {
    parts.push("Per-user data");
  }
  return parts.join(" · ");
}

function sharePrefsOptions(cloud: CloudPublishControls): {
  requireSignIn?: boolean;
  perUserIsolation?: boolean;
  allowedUserIds?: string[];
} {
  return {
    requireSignIn: cloud.sharePrefs?.requireSignIn,
    perUserIsolation: cloud.sharePrefs?.perUserIsolation,
    // Presence of this list is what makes loginAccess "team" read back as
    // audience "people" rather than "anyone in my workspace".
    allowedUserIds: cloud.sharePrefs?.allowedUserIds,
  };
}

function requireSignInFromModel(model: ShareAudienceModel): boolean {
  if (model.audience === "public") {
    return model.requireSignIn === true;
  }
  if (model.audience === "link") {
    return model.requireSignIn !== false;
  }
  return true;
}

type ShareStep = "who" | "access" | "keys";

/**
 * Same glyphs as the Share button's audience icon and the prototype's audIcon.
 * Audience is the one answer that shows up outside this sheet, so the icon has
 * to be learned here and recognised on the bar — different art in the two
 * places would break that.
 */
function ShareOptionGlyph({ audience }: { audience: ShareAudience }) {
  const d =
    audience === "public"
      ? "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM1.5 8h13M8 1.5c1.7 1.8 2.6 4.1 2.6 6.5S9.7 12.7 8 14.5c-1.7-1.8-2.6-4.1-2.6-6.5S6.3 3.3 8 1.5Z"
      : audience === "team"
        ? "M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM1.5 13c0-2 2-3.5 4.5-3.5s4.5 1.5 4.5 3.5M11 3.2a2.25 2.25 0 0 1 0 4.4M12.2 9.8c1.4.5 2.3 1.7 2.3 3.2"
        : // "people" is one person plus a check — deliberately a variation on
          // the team glyph, since it is the narrower form of the same idea.
          audience === "people"
          ? "M7 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM2 13.5c0-2.2 2.2-3.9 5-3.9M10.5 12.2l1.4 1.4 2.6-2.8"
          : audience === "link"
          ? "M6.5 9.5a2.8 2.8 0 0 0 4 0l2-2a2.83 2.83 0 0 0-4-4l-1 1M9.5 6.5a2.8 2.8 0 0 0-4 0l-2 2a2.83 2.83 0 0 0 4 4l1-1"
          : "M4.5 7V5.2a3.5 3.5 0 0 1 7 0V7M3.5 7h9v6.5h-9V7Z";
  return (
    <span className="share-sheet__opt-glyph" aria-hidden>
      <svg viewBox="0 0 16 16" width="15" height="15" focusable="false">
        <path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** Angle brackets, inline in the "can edit code" label — same mark the Share
 *  button badges, so the glyph means one thing everywhere it appears. */
function InlineCodeGlyph() {
  return (
    <span className="share-sheet__inline-code" aria-hidden>
      <svg viewBox="0 0 16 16" width="11" height="11" focusable="false">
        <path
          d="M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** Switch, not a checkbox. Sign-in and per-user data are settings you flip on
 *  an app, not items you tick in a list — and the radio options they sit beside
 *  already own the "pick one of these" shape. */
function ShareSwitch({ on }: { on: boolean }) {
  return (
    <span
      className={`share-sheet__switch${on ? " share-sheet__switch--on" : ""}`}
      aria-hidden
    >
      <i />
    </span>
  );
}

/**
 * Three ordered questions instead of one long form. Merged down from four:
 * code access, sign-in and per-user data all answer "what does a visitor get",
 * so splitting them made the sheet feel longer without making any one choice
 * easier.
 *
 * Tabs rather than a forced funnel — editing an existing app's sharing is
 * usually a one-field change, so you can jump straight to the field you came
 * for. Each tab carries its current answer, so the strip doubles as a summary.
 */
function ShareStepTabs({
  step,
  onStep,
  answers,
  dimmed,
}: {
  step: ShareStep;
  onStep: (next: ShareStep) => void;
  answers: Record<ShareStep, string>;
  dimmed: Record<ShareStep, boolean>;
}) {
  const steps: { id: ShareStep; n: number; title: string }[] = [
    { id: "who", n: 1, title: "Who" },
    { id: "access", n: 2, title: "Access" },
    { id: "keys", n: 3, title: "Keys" },
  ];
  return (
    <div className="share-steps" role="tablist">
      {steps.map((s) => (
        <button
          key={s.id}
          type="button"
          role="tab"
          aria-selected={step === s.id}
          className={`share-steps__tab${step === s.id ? " share-steps__tab--on" : ""}${
            dimmed[s.id] ? " share-steps__tab--dim" : ""
          }`}
          onClick={() => onStep(s.id)}
        >
          <b>
            {s.n}. {s.title}
          </b>
          <span>{answers[s.id]}</span>
        </button>
      ))}
    </div>
  );
}

interface ShareSheetProps {
  title: string;
  /** Sits beside the title — the link is what most visits to this sheet want. */
  headerAside?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}

function ShareSheet({ title, headerAside, onClose, children }: ShareSheetProps) {
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
          {headerAside}
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
  workspacePanel,
  onWorkspacePanelChange,
  linkedJobCount = 0,
  onTrackPullComplete,
  onRefreshPreview,
  previewTabVisible = true,
  previewShellLoaded = true,
  onOpenDependencyApp,
}: MiniAppPublishBarProps) {
  const [shareOpen, setShareOpen] = useState(false);
  const [contributionsOpen, setContributionsOpen] = useState(false);
  const [audience, setAudience] = useState<ShareAudience>("private");
  const [permission, setPermission] = useState<SharePermission>("write");
  // Audience "people": the picked allowlist plus the roster it is picked from.
  const [allowedUserIds, setAllowedUserIds] = useState<string[]>([]);
  const [workspacePeople, setWorkspacePeople] = useState<SharePeopleMember[]>([]);
  const [workspacePeopleLoading, setWorkspacePeopleLoading] = useState(false);
  const [workspaceSelfId, setWorkspaceSelfId] = useState<string | null>(null);
  const workspacePeopleLoadedRef = useRef(false);

  /**
   * Fetch the roster lazily — only when "Specific people" is actually chosen.
   * Loading every workspace member just to render four radio buttons would tax
   * every share sheet for a mode most apps never use.
   */
  const ensureWorkspacePeople = async () => {
    if (workspacePeopleLoadedRef.current || workspacePeopleLoading) return;
    workspacePeopleLoadedRef.current = true;
    setWorkspacePeopleLoading(true);
    try {
      const result = await window.electronAPI.papr.listWorkspaceMembers();
      if (result.success) {
        setWorkspaceSelfId(result.currentUserId ?? null);
        setWorkspacePeople(
          (result.members ?? []).map((member) => ({
            userId: member.user.objectId,
            displayName: member.user.displayName,
            email: member.user.email,
            imageUrl: member.user.profileImageUrl,
          })),
        );
      } else {
        // Allow a retry — a failed load must not permanently empty the picker.
        workspacePeopleLoadedRef.current = false;
      }
    } catch {
      workspacePeopleLoadedRef.current = false;
    } finally {
      setWorkspacePeopleLoading(false);
    }
  };
  const [requireSignIn, setRequireSignIn] = useState(true);
  const [perUserIsolation, setPerUserIsolation] = useState(false);
  /** Share sheet reads as three ordered questions rather than one long form. */
  const [shareStep, setShareStep] = useState<"who" | "access" | "keys">("who");
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
  const [readiness, setReadiness] = useState<CloudPublishReadinessReport | null>(
    null,
  );
  const [compatLoading, setCompatLoading] = useState(false);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [needsDesktopAck, setNeedsDesktopAck] = useState(false);
  const [publishErrorDetailOpen, setPublishErrorDetailOpen] = useState(false);
  const [webSyncActionNotice, setWebSyncActionNotice] = useState<string | null>(
    null,
  );
  const [webSyncActionKind, setWebSyncActionKind] = useState<
    "review" | "failed"
  >("review");
  const prevMergeRequiredRef = useRef(false);
  const [upstreamPulling, setUpstreamPulling] = useState(false);

  const {
    status: webSyncStatus,
    loading: webSyncLoading,
    refreshing: webSyncRefreshing,
    pushing: webSyncPushing,
    pulling: webSyncPulling,
    applyingUpdates: webSyncApplyingUpdates,
    error: webSyncError,
    globalAutoUploadEnabled,
    pushNow: webSyncPushNow,
    bumpQueue: webSyncBumpQueue,
    pullUpdates: webSyncPullUpdates,
    applyRemoteUpdates: webSyncApplyRemoteUpdates,
    checkStatus: webSyncCheckStatus,
    needsStatusCheck: webSyncNeedsStatusCheck,
    lastCheckedAt: webSyncLastCheckedAt,
    publisherUpdatesAvailable: webSyncPublisherUpdatesAvailable,
    refresh: webSyncRefresh,
  } = useAppCloudSyncStatus(appId, {
    enabled: workspaceMode === "preview",
    previewTabVisible,
    previewShellLoaded,
  });

  const guardedWebSyncPushNow = useCallback(async () => {
    if (!requestPaprCloudFeature("publish_share")) {
      return;
    }
    await webSyncPushNow();
  }, [webSyncPushNow]);

  const autoUploadEnabled = resolveEffectiveAutoUpload(
    cloud.uploadMode,
    globalAutoUploadEnabled,
  );

  // Callout strip: review + failed only. Updates and unpublished local work
  // are shown on the chip and primary button (v2 bar), not a second banner.
  const prevFailedRef = useRef(false);

  useEffect(() => {
    const mergeRequired = webSyncStatus?.gitRemoteRequiresReview === true;
    if (mergeRequired && !prevMergeRequiredRef.current) {
      const headline = webSyncStatus?.gitRemoteReviewHeadline?.trim();
      setWebSyncActionNotice(
        headline
          ? `${headline} — review before publishing.`
          : "The web has changes that need your review before you can upload.",
      );
      setWebSyncActionKind("review");
      setWebSyncPopoverOpen(true);
    }
    if (!mergeRequired && webSyncActionKind === "review") {
      setWebSyncActionNotice(null);
    }
    prevMergeRequiredRef.current = mergeRequired;
  }, [
    webSyncStatus?.gitRemoteRequiresReview,
    webSyncStatus?.gitRemoteReviewHeadline,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const failed =
      webSyncStatus?.codeStatus === "failed" ||
      (webSyncStatus?.uploadStatus === "failed" &&
        webSyncStatus?.uploadRetryPending !== true);
    if (failed && !prevFailedRef.current && !webSyncPushing) {
      setWebSyncActionNotice(
        "Publish didn't finish — your latest changes aren't on the web yet.",
      );
      setWebSyncActionKind("failed");
    }
    if (!failed && webSyncActionKind === "failed") {
      setWebSyncActionNotice(null);
    }
    prevFailedRef.current = Boolean(failed);
  }, [webSyncStatus?.codeStatus, webSyncStatus?.uploadStatus, webSyncStatus?.uploadRetryPending, webSyncPushing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setCompatReport(cloud.compatibility);
  }, [cloud.compatibility]);

  // MiniAppView is reused across app tabs — reset transient UI when switching apps
  // so one app's publish/upload does not lock another app's share sheet.
  useEffect(() => {
    setShareOpen(false);
    setShareSyncNotice(null);
    applyingSharingRef.current = false;
    setNeedsDesktopAck(false);
    setWebSyncPopoverOpen(false);
    setWebSyncActionNotice(null);
    prevMergeRequiredRef.current = false;
    prevFailedRef.current = false;
    const model = sharingToAudienceModel(
      cloud.loginAccess,
      cloud.externalLink,
      cloud.codeAccess,
      sharePrefsOptions(cloud),
    );
    setAudience(model.audience);
    setPermission(model.permission);
    setRequireSignIn(requireSignInFromModel(model));
    setPerUserIsolation(model.perUserIsolation === true);
    setAllowedUserIds(model.allowedUserIds ?? []);
    if (model.audience === "people") {
      // Names have to resolve before the saved allowlist can be rendered as
      // chips rather than raw ids.
      void ensureWorkspacePeople();
    }
  }, [appId]); // eslint-disable-line react-hooks/exhaustive-deps -- cloud.* read only on app switch

  useEffect(() => {
    if (!shareOpen) {
      setNeedsDesktopAck(false);
      setShareSyncNotice(null);
      setReadiness(null);
      return;
    }
    setCompatLoading(true);
    setReadinessLoading(true);
    void fetchCloudCompatibility(appId)
      .then(setCompatReport)
      .catch(() => {
        if (cloud.compatibility) setCompatReport(cloud.compatibility);
      })
      .finally(() => setCompatLoading(false));
    void fetchCloudPublishReadiness(appId)
      .then(setReadiness)
      .catch(() => setReadiness(null))
      .finally(() => setReadinessLoading(false));
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
      sharePrefsOptions(cloud),
    );
    setAudience(model.audience);
    setPermission(model.permission);
    setRequireSignIn(requireSignInFromModel(model));
    setPerUserIsolation(model.perUserIsolation === true);
    setAllowedUserIds(model.allowedUserIds ?? []);
    if (model.audience === "people") {
      // Names have to resolve before the saved allowlist can be rendered as
      // chips rather than raw ids.
      void ensureWorkspacePeople();
    }
  }, [
    appId,
    shareOpen,
    cloud.loginAccess,
    cloud.externalLink,
    cloud.codeAccess,
    cloud.sharePrefs?.requireSignIn,
    cloud.sharePrefs?.perUserIsolation,
  ]);

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

  const buildShareModel = (
    nextAudience: ShareAudience,
    nextPermission: SharePermission,
    nextRequireSignIn: boolean,
    nextPerUserIsolation: boolean,
    nextAllowedUserIds: string[] = allowedUserIds,
  ): ShareAudienceModel => {
    const signInApplies = nextAudience === "link" || nextAudience === "public";
    const isolationApplies =
      nextAudience === "team" ||
      nextAudience === "people" ||
      (signInApplies && nextRequireSignIn);
    return {
      audience: nextAudience,
      permission: nextPermission,
      ...(signInApplies ? { requireSignIn: nextRequireSignIn } : {}),
      ...(isolationApplies ? { perUserIsolation: nextPerUserIsolation } : {}),
      // Sent only for "people" so switching away clears the allowlist instead
      // of leaving a stale one to be silently re-applied later.
      ...(nextAudience === "people"
        ? { allowedUserIds: nextAllowedUserIds }
        : {}),
    };
  };

  const applySharing = async (
    nextAudience: ShareAudience,
    nextPermission: SharePermission,
    nextRequireSignIn = requireSignIn,
    nextPerUserIsolation = perUserIsolation,
    nextAllowedUserIds = allowedUserIds,
  ): Promise<{ published: boolean }> => {
    setAudience(nextAudience);
    setPermission(nextPermission);
    if (nextAudience === "link" || nextAudience === "public") {
      setRequireSignIn(nextRequireSignIn);
    }
    if (
      nextAudience === "team" ||
      nextAudience === "people" ||
      ((nextAudience === "link" || nextAudience === "public") && nextRequireSignIn)
    ) {
      setPerUserIsolation(nextPerUserIsolation);
    }
    const model =
      nextAudience === "private"
        ? buildShareModel(
            "private",
            "read",
            nextRequireSignIn,
            nextPerUserIsolation,
            nextAllowedUserIds,
          )
        : buildShareModel(
            nextAudience,
            nextPermission,
            nextRequireSignIn,
            nextPerUserIsolation,
            nextAllowedUserIds,
          );
    if (
      model.audience !== "private" &&
      !isPermissionAvailable(model.audience, model.permission)
    ) {
      return { published: false };
    }

    applyingSharingRef.current = true;
    setShareSyncNotice("Saving sharing settings…");
    try {
      await cloud.updateSharing(model);
      const needsCodeUpload = audienceModelNeedsInitialCodeUpload(model, cloud.live);
      if (needsCodeUpload) {
        setShareSyncNotice("Publishing app code and databases to the web…");
        await guardedWebSyncPushNow();
      }
      return { published: needsCodeUpload };
    } catch (err) {
      if (err instanceof CloudPublishBlockedError) {
        cloud.clearError();
        setCompatReport(err.compatibility);
        setNeedsDesktopAck(true);
        setShareOpen(true);
        return { published: false };
      }
      throw err;
    } finally {
      applyingSharingRef.current = false;
      setShareSyncNotice(null);
    }
  };

  const appliedModel = sharingToAudienceModel(
    cloud.loginAccess,
    cloud.externalLink,
    cloud.codeAccess,
    sharePrefsOptions(cloud),
  );
  const appliedRequireSignIn = requireSignInFromModel(appliedModel);
  const appliedPerUserIsolation = appliedModel.perUserIsolation === true;
  const appliedAllowedUserIds = appliedModel.allowedUserIds ?? [];
  const hasSharingDraftChanges =
    audience !== appliedModel.audience ||
    permission !== appliedModel.permission ||
    ((audience === "link" || audience === "public") &&
      requireSignIn !== appliedRequireSignIn) ||
    // Order is meaningful to the reader but not to access, so compare as a set.
    (audience === "people" &&
      (allowedUserIds.length !== appliedAllowedUserIds.length ||
        allowedUserIds.some((id) => !appliedAllowedUserIds.includes(id)))) ||
    perUserIsolation !== appliedPerUserIsolation;

  const pickAudience = (nextAudience: ShareAudience) => {
    let nextPermission = permission;
    if (nextAudience === "private") {
      nextPermission = "read";
    } else if (!isPermissionAvailable(nextAudience, nextPermission)) {
      nextPermission = "write";
    }
    setAudience(nextAudience);
    setPermission(nextPermission);
    if (nextAudience === "people") {
      void ensureWorkspacePeople();
    }
    if (nextAudience === "link") {
      setRequireSignIn(true);
      setPerUserIsolation(true);
    } else if (nextAudience === "public") {
      setRequireSignIn(false);
      setPerUserIsolation(false);
    }
  };

  const pickPermission = (nextPermission: SharePermission) => {
    if (!isPermissionAvailable(audience, nextPermission)) return;
    setPermission(nextPermission);
  };

  const saveSharingSettings = () => {
    void applySharing(
      audience,
      permission,
      requireSignIn,
      perUserIsolation,
      allowedUserIds,
    );
  };

  const showSignInToggle = audience === "link" || audience === "public";
  const showPerUserIsolationToggle =
    audience === "team" ||
    ((audience === "link" || audience === "public") && requireSignIn);

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
  const copyUrl = isTrackCollaborator
    ? upstreamWebUrl
    : cloud.externalLinkUrl ?? cloud.loginUrl ?? webDisplayUrl;
  /** Shareable web URL only — never localhost (misleading when previewing locally). */
  const previewDisplayUrl = isTrackCollaborator
    ? upstreamWebUrl
    : cloud.live
      ? (copyUrl ?? webDisplayUrl)
      : null;
  const showWebPanel = isWebLinkPermission(permission);
  const showCodePanel = isCodePermission(permission);
  const listsInCommunity = shouldListInCommunity(audience, cloud.live);
  const isFork = Boolean(cloudLineage);
  const showUpstreamBar = viewMode === "local" && isFork && cloudLineage;

  const showOwnerChangeRequests =
    cloud.live && isCodePermission(permission) && !isFork;

  const incomingChanges = useIncomingCloudChangeRequests(
    showOwnerChangeRequests ? appId : null,
  );

  useEffect(() => {
    if (incomingChanges.pending.length > 0) {
      setContributionsOpen(true);
    } else {
      setContributionsOpen(false);
    }
  }, [incomingChanges.pending.length]);

  const showContributionsInbox =
    showOwnerChangeRequests && incomingChanges.pending.length > 0;

  const removeFromCommunity = () => {
    const nextPermission = permission === "edit" ? "edit" : "write";
    void applySharing("link", nextPermission, false);
  };

  const takeOffWeb = () => {
    void cloud.unpublish();
    setShareOpen(false);
  };

  const canOpenWebPreview = isTrackCollaborator
    ? !!upstreamPreviewUrl
    : cloud.live && !!cloud.publishedPreviewUrl;
  // Chip stays calm until a user-initiated or in-flight refresh — not hook
  // `loading` on tab open before the first /api/sync/items round-trip.
  const webSyncTooltip = formatWebSyncStatusTooltip(webSyncStatus, {
    error: webSyncError,
    refreshing: webSyncRefreshing,
  });
  const webSyncState = webSyncVisualState(webSyncStatus, {
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
    webSyncApplyingUpdates ||
    webSyncRefreshing ||
    webSyncState === "syncing";
  const cloudPublishFailed =
    Boolean(cloud.errorDetail) && !needsDesktopAck;
  useEffect(() => {
    if (!cloudPublishFailed) {
      setPublishErrorDetailOpen(false);
    }
  }, [cloudPublishFailed]);

  const publishBarStatus = resolvePublishBarStatus({
    live: cloud.live,
    loading: cloud.loading,
    refreshing: cloud.refreshing,
    syncEnabled: workspaceMode === "preview",
    webSyncState,
    webSyncSpinning,
    webSyncTooltip,
    cloudPublishFailed,
    cloudPublishErrorDetail: cloud.errorDetail,
  });
  // Re-render on a slow tick so the chip's age ("web checked 4 min ago") keeps
  // counting up while the tab sits open instead of freezing at its first value.
  const [, setChipAgeTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setChipAgeTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const forkWebPreview =
    workspaceMode === "preview" && viewMode === "published" && isFork;
  const forkUpstreamChip = resolvePublishBarChipForForkUpstream({
    forkWebPreview,
    publisherUpdatesAvailable: webSyncPublisherUpdatesAvailable,
  });
  const publishBarChipBase = resolvePublishBarChipLabel({
    state: publishBarStatus.state,
    live: cloud.live,
    syncEnabled: workspaceMode === "preview",
    lastCheckedAt: webSyncLastCheckedAt,
    // "Just published" is a fresh-confirmation window: for ~2 minutes after a
    // publish the chip confirms that write, then falls back to the check age.
    lastPublishedAt: webSyncStatus?.lastUploadedAt ?? null,
    cloudPublishFailed,
  });
  const forkChipOverrides =
    forkUpstreamChip != null &&
    publishBarStatus.state !== "action_required" &&
    publishBarStatus.state !== "error";
  const publishBarChip = forkChipOverrides
    ? {
        label: forkUpstreamChip.label,
        showRefresh: false,
        tone: forkUpstreamChip.tone,
      }
    : publishBarChipBase;
  const publishBarChipState = forkChipOverrides
    ? forkUpstreamChip.state
    : publishBarStatus.state;
  // Preview mode uses the chip for all web-sync states; draft publish failures
  // show the chip even in Files mode so "Failed to publish" is one click away.
  const chipSpeaks = workspaceMode === "preview" || cloudPublishFailed;
  const metaStatusText = (() => {
    const lineage =
      isFork && cloudLineage && !showUpstreamBar
        ? `${cloudLineage.mode === "track" ? "Tracking" : "Fork"} ${cloudLineage.sourceSlug}`
        : null;
    if (chipSpeaks) return lineage;
    if (cloud.loading && !cloud.live) return lineage ?? "Draft";
    const base = `${cloud.live ? "Live" : "Draft"} · ${cloud.statusLabel}${
      cloud.refreshing && cloud.live ? " · updating" : ""
    }`;
    return lineage ? `${base} · ${lineage}` : base;
  })();
  const publishBarAction = resolvePublishBarPrimaryAction({
    state: publishBarStatus.state,
    live: cloud.live,
    syncEnabled: workspaceMode === "preview",
    pushing: webSyncPushing || Boolean(shareSyncNotice),
    pulling: webSyncPulling,
    pullingUpstream: upstreamPulling,
    publisherUpdatesAvailable: webSyncPublisherUpdatesAvailable,
    forkWebPreview,
  });
  const shareSheetBusy =
    cloud.busy || webSyncPushing || Boolean(shareSyncNotice);
  const publishBlockedByIntegrity = readiness?.ok === false;
  const shareLinkReady =
    cloud.live &&
    webSyncStatus?.overall === "synced" &&
    webSyncStatus?.publishStatus !== "not_web_ready" &&
    webSyncStatus?.publishStatus !== "drift" &&
    webSyncStatus?.publishStatus !== "error" &&
    !webSyncPushing &&
    !shareSyncNotice;

  const shareSelectionSummary = formatShareSelectionSummary(
    audience,
    permission,
    requireSignIn,
    perUserIsolation,
  );
  /**
   * Later steps are meaningless for a private app. Dim them and say so rather
   * than hiding them — a step that vanishes reads as a bug, a step that
   * explains itself teaches the dependency.
   */
  const stepDimmed: Record<ShareStep, boolean> = {
    who: false,
    access: audience === "private",
    keys: audience === "private",
  };
  const stepAnswers: Record<ShareStep, string> = {
    who: ACCESS_OPTIONS.find((o) => o.value === audience)?.label ?? audience,
    access: stepDimmed.access
      ? "—"
      : `${permission === "edit" ? "Use + code" : "Use only"} · ${
          requireSignIn ? "sign in" : "no sign-in"
        } · ${perUserIsolation && requireSignIn ? "separate DBs" : "one DB"}`,
    keys: stepDimmed.keys ? "—" : "Per key",
  };

  // The link lives in the header: it is what most visits to this sheet are for,
  // and burying it behind a tab to gain consistency would be a bad trade.
  const shareLinkNode =
    cloud.live && (copyUrl || webDisplayUrl) ? (
      <div className="share-sheet__header-link">
        <input
          className="share-sheet__url-input"
          readOnly
          value={copyUrl ?? webDisplayUrl ?? ""}
          aria-label="Share link"
          title={copyUrl ?? webDisplayUrl ?? ""}
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
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
          onClick={() => void cloud.openInBrowser(copyUrl ?? webDisplayUrl)}
        >
          <OpenExternalIcon />
        </button>
      </div>
    ) : null;

  const shareSyncBanner = (() => {
    if (cloud.errorDetail && !needsDesktopAck) {
      return {
        tone: "error" as const,
        message: "Failed to publish",
        detail: cloud.errorDetail,
      };
    }
    if (shareSyncNotice) {
      return { tone: "info" as const, message: shareSyncNotice };
    }
    if (cloud.busy) {
      return { tone: "info" as const, message: "Saving sharing settings…" };
    }
    if (webSyncPushing) {
      return {
        tone: "info" as const,
        message: "Publishing app code and databases to the web…",
      };
    }
    if (
      cloud.live &&
      (webSyncStatus?.overall === "needs_sync" ||
        webSyncStatus?.publishStatus === "not_web_ready")
    ) {
      return {
        tone: "warn" as const,
        message:
          webSyncStatus?.publishDetail?.trim() ??
          "Sharing is saved, but the live link won't work until upload finishes.",
      };
    }
    // No success banner. The link sitting in the header already proves the app
    // is live, and a banner saying so pushes the actual controls down to
    // announce the absence of a problem. Banners are for exceptions.
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

  const handlePublishStatusChipClick = () => {
    if (cloudPublishFailed) {
      setPublishErrorDetailOpen(true);
      return;
    }
    handleWebSyncDotClick();
  };

  const handlePublishClick = async () => {
    if (publishBlockedByIntegrity) {
      return;
    }
    if (!requestPaprCloudFeature("publish_share")) {
      return;
    }
    setShareSyncNotice("Publishing to the web…");
    try {
      let published = cloud.live;
      if (hasSharingDraftChanges || !cloud.live) {
        const result = await applySharing(
          audience,
          permission,
          requireSignIn,
          perUserIsolation,
        );
        published = published || result.published;
      }
      if (!published) {
        await cloud.publish();
        setNeedsDesktopAck(false);
        setShareSyncNotice("Publishing app code and databases to the web…");
        await guardedWebSyncPushNow();
      }
    } catch (err) {
      if (err instanceof CloudPublishBlockedError) {
        cloud.clearError();
        setCompatReport(err.compatibility);
        setNeedsDesktopAck(true);
        setShareOpen(true);
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
        setShareSyncNotice("Publishing app code and databases to the web…");
        await guardedWebSyncPushNow();
      })
      .catch((err: unknown) => {
        if (err instanceof CloudPublishBlockedError) {
          cloud.clearError();
          setCompatReport(err.compatibility);
          setNeedsDesktopAck(true);
        }
      })
      .finally(() => {
        setShareSyncNotice(null);
      });
  };

  const handleWebSyncPushOrPublish = async () => {
    if (!cloud.live) {
      await handlePublishClick();
      return;
    }
    await guardedWebSyncPushNow();
  };

  return (
    <>
      <div className="mini-app-publish-bar">
        <div className="mini-app-publish-bar__left">
          <div className="mini-app-publish-bar__meta">
            <span className="mini-app-publish-bar__title">{appTitle}</span>
            {/* Compatibility levels (Hybrid / Desktop only) no longer badge the
                bar — see CloudCompatibilityBadge. This stays mounted because it
                is also the only surface for "Papr Cloud paused". */}
            <CloudCompatibilityBadge
              report={compatReport ?? cloud.compatibility}
              loading={false}
            />
            {/* When the chip speaks it owns Live/Draft and the busy state, and
                audience moved to the Share icon — so this line has nothing left
                to say and is dropped entirely rather than rendered empty. */}
            {metaStatusText ? (
              <span className="mini-app-publish-bar__status">
                {metaStatusText}
              </span>
            ) : null}
            {/* Status belongs to the app, so it sits with the app's name —
                not inside the Local/Web toggle, which is about which preview
                you are looking at. */}
            {chipSpeaks ? (
              <span
                ref={webSyncAnchorRef}
                className="mini-app-publish-bar__chip-anchor"
              >
                <WebSyncStatusDot
                  state={publishBarChipState}
                  spinning={publishBarStatus.spinning}
                  tooltip={publishBarStatus.tooltip}
                  popoverOpen={webSyncPopoverOpen}
                  interactive={publishBarStatus.interactive}
                  onClick={handlePublishStatusChipClick}
                  label={publishBarChip.label}
                  tone={publishBarChip.tone}
                  onRefresh={
                    publishBarChip.showRefresh
                      ? () => void webSyncCheckStatus()
                      : undefined
                  }
                />
              </span>
            ) : null}
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
            </div>
            {webSyncPopoverOpen && webSyncPopoverPos
              ? createPortal(
                  <WebSyncPopover
                    popoverRef={webSyncPopoverRef}
                    appId={appId}
                    className="mini-app-publish-bar__sync-popover--portal"
                    style={{
                      position: "fixed",
                      top: webSyncPopoverPos.top,
                      left: webSyncPopoverPos.left,
                      zIndex: 10000,
                    }}
                    status={webSyncStatus}
                    loading={webSyncLoading && !webSyncStatus}
                    refreshing={webSyncRefreshing}
                    error={webSyncError}
                    pushing={webSyncPushing || Boolean(shareSyncNotice)}
                    pulling={webSyncPulling}
                    applyingUpdates={webSyncApplyingUpdates}
                    syncActionNeeded={webSyncActionNeeded}
                    appLive={cloud.live}
                    autoUploadEnabled={autoUploadEnabled}
                    onPushNow={() => void handleWebSyncPushOrPublish()}
                    onBumpQueue={() => void webSyncBumpQueue()}
                    onPullUpdates={() => void webSyncPullUpdates()}
                    onApplyRemoteUpdates={() => void webSyncApplyRemoteUpdates()}
                    needsStatusCheck={webSyncNeedsStatusCheck}
                    lastCheckedAt={webSyncLastCheckedAt}
                    onCheckStatus={() => void webSyncCheckStatus()}
                  />,
                  document.body,
                )
              : null}
          </div>
        ) : (
          <AppWorkspacePanelMenu
            panel={workspacePanel}
            onPanelChange={onWorkspacePanelChange}
            jobCount={linkedJobCount}
          />
        )}

        {workspaceMode === "preview" && previewDisplayUrl ? (
          <PreviewUrlRow
            displayUrl={previewDisplayUrl}
            refreshTitle={
              viewMode === "published"
                ? "Refresh web preview"
                : "Refresh local preview"
            }
            onRefresh={() => onRefreshPreview?.()}
            onOpenInBrowser={() => void cloud.openInBrowser(previewDisplayUrl)}
            onCopySuccess={cloud.notifyLinkCopied}
            onCopyError={cloud.notifyLinkCopyFailed}
          />
        ) : null}

        <div className="mini-app-publish-bar__actions">
          {cloud.toast ? (
            <span className="mini-app-publish-bar__toast">{cloud.toast}</span>
          ) : null}
          {cloudPublishFailed && cloud.errorDetail ? (
            <PublishBarErrorNotice
              hideInlineTrigger
              detailOpen={publishErrorDetailOpen}
              onDetailOpenChange={setPublishErrorDetailOpen}
              summary="Failed to publish"
              detail={cloud.errorDetail}
              onDismiss={cloud.clearError}
            />
          ) : null}

          {/* Files/Preview moved into the overflow: it is a mode switch, not an
              action, and it was spending a full-width button in a row that runs
              out of space before the primary action does. */}
          <PublishBarOverflowMenu
            mode={workspaceMode}
            onModeChange={onWorkspaceModeChange}
            live={cloud.live}
            isFork={isFork}
            busy={cloud.busy}
            onUnpublish={takeOffWeb}
          />

          {showContributionsInbox ? (
            <button
              type="button"
              className="mini-app-publish-bar__button mini-app-publish-bar__button--icon"
              disabled={cloud.busy}
              aria-expanded={contributionsOpen}
              aria-label={`Contributions${
                incomingChanges.pending.length > 0
                  ? `, ${incomingChanges.pending.length} pending`
                  : ""
              }`}
              title={
                incomingChanges.pending.length > 0
                  ? `${incomingChanges.pending.length} contributions waiting for review`
                  : "Contributions"
              }
              onClick={() => setContributionsOpen((open) => !open)}
            >
              {/* Inbox glyph plus a count, not the word: the number is the only
                  part that changes and the only part worth reading at a glance,
                  and "Contributions" cost more width than the bar can spare. */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 13h4l1.5 3h5L16 13h4M4 13 6.5 5h11L20 13v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {incomingChanges.pending.length > 0 ? (
                <span className="mini-app-publish-bar__contributions-badge">
                  {incomingChanges.pending.length}
                </span>
              ) : null}
            </button>
          ) : null}

          {/* Draft has nothing to share yet, so Share waits until the app is
              live and Publish carries the primary weight instead. */}
          {cloud.live ? (
            <button
              type="button"
              className={`mini-app-publish-bar__button${
                publishBarAction ? "" : " mini-app-publish-bar__button--primary"
              }`}
              disabled={cloud.busy}
              title={`Shared: ${cloud.statusLabel}`}
              onClick={() => setShareOpen(true)}
            >
              <ShareAudienceIcon
                loginAccess={cloud.loginAccess}
                codeAccess={cloud.codeAccess}
              />
              {isFork ? "Share my copy" : "Share"}
            </button>
          ) : null}

          {/* Persistent, not a dismissible banner: unpublished work is a
              standing fact, and the action for it should not disappear. */}
          {publishBarAction ? (
            <button
              type="button"
              className={`mini-app-publish-bar__button mini-app-publish-bar__button--primary${
                publishBarAction.kind === "review" || publishBarAction.kind === "retry"
                  ? " mini-app-publish-bar__button--tone-bad"
                  : publishBarAction.kind === "updates" ||
                      publishBarAction.kind === "upstream"
                    ? " mini-app-publish-bar__button--tone-info"
                    : ""
              }`}
              disabled={
                webSyncPushing ||
                webSyncPulling ||
                upstreamPulling ||
                cloud.busy
              }
              onClick={() => {
                if (publishBarAction.kind === "updates") {
                  void webSyncPullUpdates();
                } else if (publishBarAction.kind === "upstream") {
                  void (async () => {
                    setUpstreamPulling(true);
                    try {
                      await pullTrackUpstream(appId);
                      await webSyncRefresh(true);
                    } finally {
                      setUpstreamPulling(false);
                    }
                  })();
                } else if (publishBarAction.kind === "review") {
                  handleWebSyncDotClick();
                } else {
                  void handleWebSyncPushOrPublish();
                }
              }}
            >
              {publishBarAction.label}
            </button>
          ) : null}
        </div>
      </div>

      {showContributionsInbox && contributionsOpen ? (
        <div className="mini-app-publish-bar__contributions-panel">
          <CloudChangeRequestsPanel
            busy={cloud.busy}
            variant="publish-bar"
            requests={incomingChanges.requests}
            pending={incomingChanges.pending}
            loading={incomingChanges.loading}
            error={incomingChanges.error}
            onReload={incomingChanges.reload}
          />
        </div>
      ) : null}

      {workspaceMode === "preview" &&
      webSyncActionNotice &&
      (webSyncActionKind === "failed" || webSyncActionKind === "review") ? (
        <div
          className="mini-app-publish-bar__action-callout"
          role="alert"
          aria-live="polite"
        >
          <span className="mini-app-publish-bar__action-callout-text">
            {webSyncActionNotice}
          </span>
          {/* No action button here: the bar's primary button already offers it
              persistently. This callout only explains and offers the agent. */}
          {webSyncStatus ? (
            <button
              type="button"
              className="mini-app-publish-bar__action-callout-btn mini-app-publish-bar__action-callout-btn--secondary"
              onClick={() =>
                openCloudSyncAgentChat(
                  buildGenericSyncAgentPrompt({ appId, status: webSyncStatus }),
                )
              }
            >
              Ask agent
            </button>
          ) : null}
          <button
            type="button"
            className="mini-app-publish-bar__action-callout-dismiss"
            aria-label="Dismiss"
            onClick={() => setWebSyncActionNotice(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      {shareOpen ? (
        <ShareSheet
          title="Share"
          headerAside={shareLinkNode}
          onClose={() => setShareOpen(false)}
        >

          <div className="share-sheet__panel">
            <PaprCloudRequirementsPanel featureId="publish_share" />

            {shareSyncBanner ? (
              <div
                className={`share-sheet__sync-banner share-sheet__sync-banner--${shareSyncBanner.tone}`}
                role="status"
              >
                <p>{shareSyncBanner.message}</p>
                {"detail" in shareSyncBanner &&
                shareSyncBanner.detail &&
                shareSyncBanner.detail !== shareSyncBanner.message ? (
                  <details className="share-sheet__error-details">
                    <summary>View full error</summary>
                    <p>{shareSyncBanner.detail}</p>
                  </details>
                ) : null}
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
                    onClick={() => void handleWebSyncPushOrPublish()}
                  >
                    {webSyncPushing
                      ? webSyncPushButtonLabel({ appLive: cloud.live, pushing: true })
                      : webSyncPushButtonLabel({ appLive: cloud.live, pushing: false })}
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* Link not yet usable — kept in the panel, not the header, so a
                caveat never widens the title row. */}
            {cloud.live && (copyUrl || webDisplayUrl) && !shareLinkReady ? (
              <p className="share-sheet__link-hint">
                {cloud.externalLink !== "off" && !(copyUrl ?? "").includes("?t=")
                  ? "Invite link token will appear after upload and publish finish."
                  : "The link above may show \"not found\" until upload completes."}
              </p>
            ) : null}

            <ShareStepTabs
              step={shareStep}
              onStep={setShareStep}
              answers={stepAnswers}
              dimmed={stepDimmed}
            />

            {isFork ? (
              <div className="share-sheet__notice share-sheet__notice--info">
                <p>
                  <strong>Publish your copy</strong> — this puts <em>your</em> local
                  fork on the web. It does not change the team&apos;s shared upstream
                  app.
                </p>
              </div>
            ) : null}

            {shareStep === "who" ? (
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
                      <ShareOptionGlyph audience={option.value} />
                      <span className="share-sheet__row-text">
                        <span className="share-sheet__row-label">{option.label}</span>
                        <span className="share-sheet__row-desc">{option.description}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>

              {/* Nested under the audience it belongs to: the allowlist is not
                  a separate setting, it is the rest of the sentence started by
                  "Specific people". */}
              {audience === "people" ? (
                <div className="share-sheet__people">
                  <SharePeoplePicker
                    members={workspacePeople}
                    value={allowedUserIds}
                    onChange={setAllowedUserIds}
                    loading={workspacePeopleLoading}
                    disabled={shareSheetBusy}
                    currentUserId={workspaceSelfId}
                  />
                </div>
              ) : null}
            </fieldset>
            ) : null}

            {/* Access reads as one question with its follow-ups nested, not
                four sibling settings. "Can view" is the gate: sign-in and
                per-user data only exist because someone can view, so they sit
                inside it. "Can edit code" is genuinely separate, so it sits
                outside as its own switch. */}
            {shareStep === "access" && audience !== "private" ? (
              <fieldset
                className={
                  shareSheetBusy
                    ? "share-sheet__fieldset share-sheet__fieldset--locked"
                    : "share-sheet__fieldset"
                }
              >
                <legend className="share-sheet__legend">What they get</legend>

                <div className="share-sheet__toggle-group share-sheet__toggle-group--on">
                  {/* Turning this off is not decorative — it means nobody can
                      open the app, which is exactly "Only me". So it writes
                      back to audience rather than being a switch that is
                      permanently on and does nothing. */}
                  <label className="share-sheet__toggle-row share-sheet__toggle-row--on share-sheet__toggle-row--head">
                    <span className="share-sheet__row-text">
                      <span className="share-sheet__row-label">
                        Can view and interact
                      </span>
                      <span className="share-sheet__row-desc">
                        Open the app, read data, and use interactive features
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      className="share-sheet__switch-input"
                      checked
                      onChange={() => {
                        if (shareSheetBusy) return;
                        pickAudience("private");
                        setShareStep("who");
                      }}
                    />
                    <ShareSwitch on />
                  </label>

                  {showSignInToggle || showPerUserIsolationToggle ? (
                    <div className="share-sheet__toggle-nest">
                      {showSignInToggle ? (
                        <label
                          className={`share-sheet__toggle-row${
                            requireSignIn ? " share-sheet__toggle-row--on" : ""
                          }`}
                        >
                          <span className="share-sheet__row-text">
                            <span className="share-sheet__row-label">
                              Require Papr sign-in
                            </span>
                            <span className="share-sheet__row-desc">
                              {requireSignIn
                                ? audience === "public"
                                  ? "Visitors must sign in to Papr before using the app"
                                  : "Viewers must sign in with a Papr account"
                                : audience === "public"
                                  ? "Anyone can discover and open this app without an account"
                                  : "Anyone with the link can open it without an account"}
                            </span>
                          </span>
                          <input
                            type="checkbox"
                            className="share-sheet__switch-input"
                            checked={requireSignIn}
                            onChange={(event) => {
                              if (shareSheetBusy) return;
                              const checked = event.target.checked;
                              setRequireSignIn(checked);
                              setPerUserIsolation(checked);
                            }}
                          />
                          <ShareSwitch on={requireSignIn} />
                        </label>
                      ) : null}

                      {showPerUserIsolationToggle ? (
                        <label
                          className={`share-sheet__toggle-row${
                            perUserIsolation ? " share-sheet__toggle-row--on" : ""
                          }${requireSignIn ? "" : " share-sheet__toggle-row--off"}`}
                        >
                          <span className="share-sheet__row-text">
                            <span className="share-sheet__row-label">
                              Give each person a separate database
                            </span>
                            {/* Stating the dependency beats silently disabling:
                                an anonymous visitor cannot be told apart, so
                                there is nobody to give a database to. */}
                            <span className="share-sheet__row-desc">
                              {!requireSignIn
                                ? "Needs sign-in — anonymous visitors can't be told apart."
                                : perUserIsolation
                                  ? "Each signed-in user gets their own private database copy"
                                  : "All signed-in users share the same database"}
                            </span>
                          </span>
                          <input
                            type="checkbox"
                            className="share-sheet__switch-input"
                            checked={perUserIsolation}
                            disabled={!requireSignIn}
                            onChange={(event) => {
                              if (shareSheetBusy) return;
                              const checked = event.target.checked;
                              setPerUserIsolation(checked);
                              if (checked) setRequireSignIn(true);
                            }}
                          />
                          <ShareSwitch on={perUserIsolation} />
                        </label>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {/* A switch, not a second radio: this is an extra capability
                    layered on viewing, and radios framed it as an alternative
                    to viewing — which it never was. */}
                {(() => {
                  const codeOption = PERMISSION_OPTIONS.find((o) => o.value === "edit");
                  const codeOn = permission === "edit";
                  const codeAvailable = isPermissionAvailable(audience, "edit");
                  if (!codeOption) return null;
                  return (
                    <label
                      className={`share-sheet__toggle-row${
                        codeOn ? " share-sheet__toggle-row--on" : ""
                      }${codeAvailable ? "" : " share-sheet__toggle-row--off"}`}
                    >
                      <span className="share-sheet__row-text">
                        <span className="share-sheet__row-label">
                          {codeOption.label}
                          <InlineCodeGlyph />
                        </span>
                        <span className="share-sheet__row-desc">
                          {codeAvailable
                            ? codeOption.description
                            : "Available for team and public apps."}
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        className="share-sheet__switch-input"
                        checked={codeOn}
                        disabled={!codeAvailable}
                        onChange={(event) => {
                          if (shareSheetBusy || !codeAvailable) return;
                          pickPermission(event.target.checked ? "edit" : "write");
                        }}
                      />
                      <ShareSwitch on={codeOn} />
                    </label>
                  );
                })()}
              </fieldset>
            ) : null}

            {cloud.live && hasSharingDraftChanges ? (
              <div className="share-sheet__section share-sheet__save-row">
                <p className="share-sheet__footnote">
                  Choose who can access and what they can do, then save — nothing
                  is published until you confirm.
                </p>
                <button
                  type="button"
                  className="share-sheet__primary-btn"
                  disabled={shareSheetBusy}
                  onClick={saveSharingSettings}
                >
                  {shareSheetBusy ? "Saving…" : "Save sharing settings"}
                </button>
              </div>
            ) : null}

            {/* Publish button if not live */}
            {!cloud.live ? (
              <div className="share-sheet__notice share-sheet__notice--info">
                <p>
                  {isFork
                    ? "Publish your copy on the web to get a shareable link for this fork."
                    : "Publish your app on the web first to get a shareable link."}
                </p>
                <CloudPublishDependenciesPanel
                  readiness={readiness}
                  loading={readinessLoading}
                  onOpenDependencyApp={onOpenDependencyApp}
                />
                <button
                  type="button"
                  className="share-sheet__primary-btn"
                  disabled={
                    shareSheetBusy || cloud.loading || publishBlockedByIntegrity
                  }
                  onClick={() => void handlePublishClick()}
                >
                  {isFork ? "Publish your copy" : "Publish on Web"}
                </button>
              </div>
            ) : (
              <CloudPublishDependenciesPanel
                readiness={readiness}
                loading={readinessLoading}
                onOpenDependencyApp={onOpenDependencyApp}
              />
            )}

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

            {/* Scope is per key in this panel, which is why the tab summary
                says "Per key" rather than one global owner/visitor answer. */}
            {shareStep === "keys" && audience !== "private" && cloud.live && !isFork ? (
              <CloudAppCredentialsPanel
                appId={appId}
                appTitle={appTitle}
                busy={cloud.busy}
              />
            ) : null}

            {/* Dimmed steps still open — saying why beats a blank panel. */}
            {shareStep !== "who" && audience === "private" ? (
              <p className="share-sheet__section-desc">
                Not needed — only you can open this app.
              </p>
            ) : null}

            {/* The green "Listed in Community Apps" notice restated the Public
                option's own description back at the person who just chose it.
                The escape hatch is the only part that carried information, so
                only it survives — as a link, since it just switches audience. */}
            {cloud.live && listsInCommunity && shareStep === "who" ? (
              <button
                type="button"
                className="share-sheet__text-link"
                disabled={cloud.busy}
                onClick={removeFromCommunity}
              >
                Unlist from Community — share via link only
              </button>
            ) : null}

            {/* The option itself already says "Install into Paprwork to
                personalize and send changes back" — repeating it here as a
                paragraph taught nothing. Only the inbox pointer survives,
                because that is the one thing the option does not say. */}
            {showCodePanel && cloud.live && showOwnerChangeRequests ? (
              <p className="share-sheet__section-desc">
                Review incoming proposals from the inbox icon on the app bar.
              </p>
            ) : null}

            {/* Unpublish lives in the bar's "..." menu now. Keeping a second
                copy here meant two routes to a destructive action and a block
                of text in a sheet that is meant to be three questions. */}

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
