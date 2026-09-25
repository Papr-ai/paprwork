/**
 * MiniAppPublishBar — publish, share, preview mode controls.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { useCloudPublish } from "../../hooks/useCloudPublish";
import { useAppCloudSyncStatus } from "../../hooks/useAppCloudSyncStatus";
import { gateway } from "../../src/lib/gateway";
import {
  formatWebSyncStatusTooltip,
  resolvePublishBarStatus,
  resolvePublishBarChipAction,
  resolvePublishBarChipForForkUpstream,
  resolvePublishBarChipLabel,
  resolvePublishBarPrimaryAction,
  resolveCollaboratorBar,
  webSyncVisualState,
} from "../../utils/appCloudSyncStatus";
import {
  discardTrackLocalEdits,
  duplicateAsOwnApp,
  fetchTrackLocalEdits,
  formatTrackSyncSummary,
  pullTrackUpstream,
} from "../../utils/cloudTrackSyncApi";
import { listSentProposals } from "../../utils/cloudContributeApi";
import type { CollaboratorLatestProposalStatus } from "../../utils/appCloudSyncStatus";
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
  publishPrefsToAudienceModel,
  shareAudienceHasPeopleRestriction,
  shouldListInCommunity,
  type ShareAudience,
  type ShareAudienceModel,
  type SharePermission,
} from "../../utils/shareAudienceModel";
import { shareAudienceGlyphPath } from "../../utils/shareAudienceGlyphs";
import type { Artifact, ArtifactCloudLineage } from "../../stores/artifactsStore";
import { CopyAppModal } from "./CopyAppModal";
import { PublishBarTitle } from "./PublishBarTitle";
import { DuplicateAppNameModal } from "./DuplicateAppNameModal";
import { usePaprNamespace } from "../../hooks/usePaprNamespace";
import {
  buildUpstreamCloudPreviewUrl,
  buildUpstreamPublishedWebUrl,
} from "../../utils/cloudDesktopPreview";
import { useIncomingCloudChangeRequests } from "../../hooks/useIncomingCloudChangeRequests";
import {
  contributionAudienceKind,
  contributionPanelCopy,
} from "../../utils/contributionPanelCopy";
import { CloudChangeRequestsPanel } from "./CloudChangeRequestsPanel";
import { CloudContributeBackPanel } from "./CloudContributeBackPanel";
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
import type { CloudCompatibilityReport } from "../../../src/core/types/cloudAppCompatibility";
import type { CloudPublishReadinessReport } from "../../../src/core/types/cloudAppDependencies";
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
  /** After an inline rename from the title. */
  onTitleChange?: (title: string) => void;
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
    description: "Teammates, guest emails, or anyone on a company domain — sign in required",
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
  allowedEmails?: string[];
  allowedEmailDomains?: string[];
} {
  return {
    requireSignIn: cloud.sharePrefs?.requireSignIn,
    perUserIsolation: cloud.sharePrefs?.perUserIsolation,
    // Presence of this list is what makes loginAccess "team" read back as
    // audience "people" rather than "anyone in my workspace".
    allowedUserIds: cloud.sharePrefs?.allowedUserIds,
    allowedEmails: cloud.sharePrefs?.allowedEmails,
    allowedEmailDomains: cloud.sharePrefs?.allowedEmailDomains,
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
  const d = shareAudienceGlyphPath(audience);
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
  /** Wider layout for contribution review cards. */
  wide?: boolean;
}

function ShareSheet({
  title,
  headerAside,
  onClose,
  children,
  wide = false,
}: ShareSheetProps) {
  return createPortal(
    <div className="share-sheet__backdrop" role="presentation" onClick={onClose}>
      <div
        className={`share-sheet${wide ? " share-sheet--wide" : ""}`}
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

function publishErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Publish failed: ${message}`.slice(0, 400);
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
  onTitleChange,
}: MiniAppPublishBarProps) {
  const [shareOpen, setShareOpen] = useState(false);
  /** Propose has its own sheet. It used to open Share and scroll to the
   *  contribute form, but Share opens on "1. Who can access your copy" with a
   *  "Publish your copy" banner — so asking to send edits upstream landed you
   *  in the flow for putting your fork on the web, a different action. */
  const [proposeOpen, setProposeOpen] = useState(false);
  /** The ▾ half of the Publish split button on a shared fork. */
  const [proposeMenuOpen, setProposeMenuOpen] = useState(false);
  const proposeMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!proposeMenuOpen) return;
    const onDown = (ev: MouseEvent) => {
      if (!proposeMenuRef.current?.contains(ev.target as Node)) {
        setProposeMenuOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setProposeMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [proposeMenuOpen]);
  const [contributionsOpen, setContributionsOpen] = useState(false);
  const [audience, setAudience] = useState<ShareAudience>("private");
  const [permission, setPermission] = useState<SharePermission>("write");
  // Audience "people": the picked allowlist plus the roster it is picked from.
  const [allowedUserIds, setAllowedUserIds] = useState<string[]>([]);
  const [allowedEmails, setAllowedEmails] = useState<string[]>([]);
  const [allowedEmailDomains, setAllowedEmailDomains] = useState<string[]>([]);
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
  const [webSyncPopoverOpen, setWebSyncPopoverOpen] = useState(false);
  const webSyncAnchorRef = useRef<HTMLDivElement>(null);
  // The desktop-only confirm renders at the bottom of a long, scrolling sheet;
  // bring it into view so "Publish on Web" doesn't look like a no-op.
  const desktopAckRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    if (needsDesktopAck) {
      desktopAckRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [needsDesktopAck]);
  const [publishErrorDetailOpen, setPublishErrorDetailOpen] = useState(false);
  const [webSyncActionNotice, setWebSyncActionNotice] = useState<string | null>(
    null,
  );
  const [webSyncActionKind, setWebSyncActionKind] = useState<
    "review" | "failed" | "propose"
  >("review");
  const prevMergeRequiredRef = useRef(false);
  const [upstreamPulling, setUpstreamPulling] = useState(false);
  /** Result of the last Update — what the pull changed, or why it failed.
   *  CloudUpstreamBar used to own this feedback; folding it in means the bar
   *  has to report it, or Update becomes a button with no visible outcome. */
  const [upstreamNotice, setUpstreamNotice] = useState<{
    tone: "ok" | "warn" | "bad";
    message: string;
  } | null>(null);

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
    publisherUpdatesAvailable: webSyncPublisherUpdatesAvailableRaw,
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

  // Post-publish propose offer (shared forks). Right after publishing your copy
  // is when proposing upstream is most likely wanted, and the ▾ is easy to
  // miss — so it is offered once, on a clean finish only. A failed or blocked
  // push disarms it rather than inviting you to propose work that never landed.
  const proposeOfferArmedRef = useRef(false);
  const prevPushingRef = useRef(false);
  useEffect(() => {
    const finished = prevPushingRef.current && !webSyncPushing;
    prevPushingRef.current = webSyncPushing;
    if (!proposeOfferArmedRef.current) return;
    if (webSyncError) {
      proposeOfferArmedRef.current = false;
      return;
    }
    if (!finished) return;
    proposeOfferArmedRef.current = false;
    if (!cloudLineage || !isTrackCollaborator) return;
    setWebSyncActionKind("propose");
    setWebSyncActionNotice(
      `Published to your copy. Propose these changes to ${cloudLineage.sourceSlug}?`,
    );
  }, [webSyncPushing, webSyncError]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setContributionsOpen(false);
    prevMergeRequiredRef.current = false;
    prevFailedRef.current = false;
    const model = publishPrefsToAudienceModel(
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
    setAllowedEmails(model.allowedEmails ?? []);
    setAllowedEmailDomains(model.allowedEmailDomains ?? []);
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

  // Keep share toggles aligned with loaded publish prefs (including after async
  // fetch), not only while the sheet is open.
  useEffect(() => {
    if (applyingSharingRef.current) return;
    const model = publishPrefsToAudienceModel(
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
    setAllowedEmails(model.allowedEmails ?? []);
    setAllowedEmailDomains(model.allowedEmailDomains ?? []);
    if (model.audience === "people") {
      // Names have to resolve before the saved allowlist can be rendered as
      // chips rather than raw ids.
      void ensureWorkspacePeople();
    }
  }, [
    appId,
    cloud.loginAccess,
    cloud.externalLink,
    cloud.codeAccess,
    cloud.sharePrefs?.requireSignIn,
    cloud.sharePrefs?.perUserIsolation,
    cloud.sharePrefs?.allowedUserIds,
    cloud.sharePrefs?.allowedEmails,
    cloud.sharePrefs?.allowedEmailDomains,
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
    nextAllowedEmails: string[] = allowedEmails,
    nextAllowedEmailDomains: string[] = allowedEmailDomains,
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
        ? {
            allowedUserIds: nextAllowedUserIds,
            allowedEmails: nextAllowedEmails,
            allowedEmailDomains: nextAllowedEmailDomains,
          }
        : {}),
    };
  };

  const applySharing = async (
    nextAudience: ShareAudience,
    nextPermission: SharePermission,
    nextRequireSignIn = requireSignIn,
    nextPerUserIsolation = perUserIsolation,
    nextAllowedUserIds = allowedUserIds,
    nextAllowedEmails = allowedEmails,
    nextAllowedEmailDomains = allowedEmailDomains,
    publishOptions?: { acknowledgeDesktopOnly?: boolean },
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
            nextAllowedEmails,
            nextAllowedEmailDomains,
          )
        : buildShareModel(
            nextAudience,
            nextPermission,
            nextRequireSignIn,
            nextPerUserIsolation,
            nextAllowedUserIds,
            nextAllowedEmails,
            nextAllowedEmailDomains,
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
      await cloud.updateSharing(model, publishOptions);
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

  const appliedModel = publishPrefsToAudienceModel(
    cloud.loginAccess,
    cloud.externalLink,
    cloud.codeAccess,
    sharePrefsOptions(cloud),
  );
  const appliedRequireSignIn = requireSignInFromModel(appliedModel);
  const appliedPerUserIsolation = appliedModel.perUserIsolation === true;
  const appliedAllowedUserIds = appliedModel.allowedUserIds ?? [];
  const appliedAllowedEmails = appliedModel.allowedEmails ?? [];
  const appliedAllowedEmailDomains = appliedModel.allowedEmailDomains ?? [];

  const stringListsEqual = (a: string[], b: string[]) =>
    a.length === b.length && a.every((value) => b.includes(value));

  const hasSharingDraftChanges =
    audience !== appliedModel.audience ||
    permission !== appliedModel.permission ||
    ((audience === "link" || audience === "public") &&
      requireSignIn !== appliedRequireSignIn) ||
    // Order is meaningful to the reader but not to access, so compare as a set.
    (audience === "people" &&
      (!stringListsEqual(allowedUserIds, appliedAllowedUserIds) ||
        !stringListsEqual(allowedEmails, appliedAllowedEmails) ||
        !stringListsEqual(
          allowedEmailDomains,
          appliedAllowedEmailDomains,
        ))) ||
    perUserIsolation !== appliedPerUserIsolation;

  // "Specific people" with no allowlist collapses to plain "team" in the
  // share model — i.e. the entire workspace, the exact opposite of the intent.
  const peopleAllowlistEmpty =
    audience === "people" &&
    !shareAudienceHasPeopleRestriction({
      allowedUserIds,
      allowedEmails,
      allowedEmailDomains,
    });

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
      allowedEmails,
      allowedEmailDomains,
    );
  };

  const showSignInToggle = audience === "link" || audience === "public";
  const showPerUserIsolationToggle =
    audience === "team" ||
    audience === "people" ||
    ((audience === "link" || audience === "public") && requireSignIn);

  const isTrackCollaborator = cloudLineage?.mode === "track";
  // A plain fork (mode "fork") is fully the user's own app: no Propose, no
  // "In sync with publisher", no "Update from publisher". Only collaborators
  // (track) stay linked to the publisher. The fork mark by the title still
  // says where it came from.
  const webSyncPublisherUpdatesAvailable =
    isTrackCollaborator && webSyncPublisherUpdatesAvailableRaw === true;
  // Whether a collaborator has anything to propose: local files vs the last
  // upstream sync snapshot. null = unknown (older installs), which never
  // blocks Propose. Re-checked when the file watcher reports a change, after
  // an upstream pull, and when the Propose sheet closes.
  const [collabLocalEdits, setCollabLocalEdits] = useState<boolean | null>(null);
  // Local edits that differ from what the last proposal sent.
  const [collabUnproposed, setCollabUnproposed] = useState<boolean | null>(null);
  // Copy to workspace: same dialog as the Apps page card menu.
  const papr = usePaprNamespace();
  const [copyToWorkspaceOpen, setCopyToWorkspaceOpen] = useState(false);
  const [duplicateNameOpen, setDuplicateNameOpen] = useState(false);
  const [currentOrganizationId, setCurrentOrganizationId] = useState<string | null>(null);
  useEffect(() => {
    if (!copyToWorkspaceOpen) return;
    let cancelled = false;
    void window.electronAPI.papr.getActiveWorkspace().then((ws) => {
      if (!cancelled) {
        setCurrentOrganizationId(ws.success ? (ws.pointer?.organizationId ?? null) : null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [copyToWorkspaceOpen]);
  const [collabEditsTick, setCollabEditsTick] = useState(0);
  useEffect(() => {
    if (!isTrackCollaborator) return;
    let cancelled = false;
    void fetchTrackLocalEdits(appId).then((r) => {
      if (cancelled) return;
      setCollabLocalEdits(r.known ? r.files.length > 0 : null);
      setCollabUnproposed(
        r.known ? (r.unproposed ?? r.files).length > 0 : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [appId, isTrackCollaborator, collabEditsTick, webSyncStatus?.hasLocalChanges, proposeOpen]);
  const [latestProposalStatus, setLatestProposalStatus] =
    useState<CollaboratorLatestProposalStatus | null>(null);
  useEffect(() => {
    if (!isTrackCollaborator) {
      setLatestProposalStatus(null);
      return;
    }
    let cancelled = false;
    void listSentProposals(appId).then((rows) => {
      if (cancelled) return;
      const newest = rows[0]?.status;
      const mapped: CollaboratorLatestProposalStatus | null =
        newest === "pending" || newest === "approved" || newest === "rejected"
          ? newest
          : null;
      setLatestProposalStatus(mapped);
    });
    return () => {
      cancelled = true;
    };
  }, [appId, isTrackCollaborator, proposeOpen, collabEditsTick]);
  const collabBar = isTrackCollaborator
    ? resolveCollaboratorBar({
        hasLocalEdits: collabLocalEdits,
        hasUnproposedEdits: collabUnproposed,
        latestProposalStatus,
        publisherAhead: webSyncPublisherUpdatesAvailable,
        pullingUpstream: upstreamPulling,
        busy: cloud.busy,
        sourceSlug: cloudLineage?.sourceSlug ?? "the publisher",
      })
    : null;
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
  const showCodePanel = isCodePermission(permission);
  const listsInCommunity = shouldListInCommunity(audience, cloud.live);
  // "Linked to a publisher" — collaborators only. Plain forks behave as owned apps.
  const isFork = isTrackCollaborator;

  // Inbox follows published prefs (`cloud.codeAccess`), not draft `permission`
  // state — that defaults to "write" and only synced while Share was open.
  const showOwnerChangeRequests =
    cloud.live && cloud.codeAccess === "install" && !isFork;

  const incomingChanges = useIncomingCloudChangeRequests(
    showOwnerChangeRequests ? appId : null,
  );

  const contributionKind = contributionAudienceKind(audience, cloud.live);
  const contributionCopy = contributionPanelCopy(contributionKind);

  // Always show the inbox for published owners with code sharing — not only when
  // the fetch returns pending rows (errors, preparing uploads, or a cleared list
  // would otherwise remove the only entry point after we dropped auto-open).
  const showContributionsInbox = showOwnerChangeRequests;
  const contributionsBadgeCount = incomingChanges.open.length;

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
    pulling: webSyncPulling,
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
  // Role, not view. Gating on viewMode split one lane across two surfaces: the
  // "Publisher has updates" chip and Update only existed in Web view, while
  // Propose only existed in Local view, so a fork never saw its full set on one
  // screen. A fork is a fork in both views — matches proposedBarV2.
  const forkWebPreview = workspaceMode === "preview" && isFork;
  // `cloud.live` means "your copy is published". A fresh fork has no share URL
  // of its own, so it read as an owner's Draft — wrong chip, Share hidden, and
  // a Publish button that duplicates Share my copy. For an unpublished fork the
  // meaningful relationship is with the publisher, not the web.
  const forkUnpublished = isFork && !cloud.live;
  // Local edits on an unpublished fork have exactly one destination — the
  // publisher — so they are "unpublished" until proposed. The file watcher
  // already knows this without a round trip; hard-coding "In sync with
  // publisher" here lied whenever you had edited anything.
  const forkUnproposedEdits =
    forkUnpublished && webSyncStatus?.hasLocalChanges === true;
  // Where local edits go: a collaborator (track) or an unpublished fork sends
  // them upstream for review; publishing your own copy lives under Share.
  const proposeIsPrimary = isTrackCollaborator || forkUnpublished;
  // A shared fork has two destinations: its own web copy (the common case,
  // reversible — so the default click) and the publisher (occasional, lands
  // in someone else's queue — so one deliberate step away on the ▾). The two
  // halves have independent enabled states: right after you publish, Publish
  // has nothing left to send, which is exactly when Propose is most wanted.
  const showProposeSplit = isFork && cloud.live && Boolean(cloudLineage);
  const openPropose = () => {
    setShareOpen(false);
    setProposeOpen(true);
  };
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
    pulling: webSyncPulling,
  });
  const forkChipOverrides =
    forkUpstreamChip != null &&
    publishBarStatus.state !== "action_required" &&
    publishBarStatus.state !== "error";
  const publishBarChip = collabBar
    ? { label: collabBar.chip.label, showRefresh: false, tone: collabBar.chip.tone }
    : forkChipOverrides
    ? {
        label: forkUpstreamChip.label,
        showRefresh: false,
        tone: forkUpstreamChip.tone,
      }
    : forkUnproposedEdits
      ? { label: "Edits not proposed", showRefresh: false, tone: "warn" as const }
      : forkUnpublished
        ? { label: "In sync with publisher", showRefresh: false, tone: "ok" as const }
        : publishBarChipBase;
  const publishBarChipState = collabBar
    ? collabBar.chip.state
    : forkChipOverrides
    ? forkUpstreamChip.state
    : forkUnproposedEdits
      ? ("warn" as const)
      : forkUnpublished
        ? ("synced" as const)
        : publishBarStatus.state;
  // Preview mode uses the chip for all web-sync states; draft publish failures
  // show the chip even in Files mode so "Failed to publish" is one click away.
  const chipSpeaks = workspaceMode === "preview" || cloudPublishFailed;
  // One phrasing for both modes. "Tracking" vs "Fork" asked the reader to know
  // the difference before the sentence told them anything; this says "Fork of
  // {slug}" either way and lets the actions differ.
  //
  // Rendered as a glyph beside the title rather than inline text: it spent the
  // widest run in the bar on a fact that never changes — you already know what
  // you installed. The mark carries the part that matters at a glance (this is
  // not your app) and the slug moves into the tooltip.
  // Applied audience, not the Share sheet draft: the mark states what is live.
  // Which mark an installed copy gets. Fork = your own app (branch glyph).
  // Collaborator on a team app = people; on a Community app = globe, same
  // marks the owner sees on their side of the same app.
  // sourceAudience is recorded at install; older installs fall back to the
  // database policy (shared = team, own data = Community).
  const lineageKind: "fork" | "team" | "people" | "community" | null = !cloudLineage
    ? null
    : cloudLineage.mode !== "track"
      ? "fork"
      : cloudLineage.sourceAudience ??
        (cloudLineage.databasePolicy === "forked" ? "community" : "team");
  const lineageTitle = !cloudLineage
    ? null
    : lineageKind === "team"
      ? `Team app from ${cloudLineage.sourceSlug}. You share its data; your code edits go to the owner as proposals.`
      : lineageKind === "people"
      ? `Shared with you by the owner of ${cloudLineage.sourceSlug}. Your code edits go to the owner as proposals.`
      : lineageKind === "community"
        ? `Community app from ${cloudLineage.sourceSlug}. Your data is your own; your code edits go to the publisher as proposals.`
        : `Forked from ${cloudLineage.sourceSlug}. Your own app: your own data and code, not linked to the publisher's edits.`;
  const metaStatusText = (() => {
    if (chipSpeaks) return null;
    if (cloud.loading && !cloud.live) return "Checking…";
    return `${cloud.live ? "Live" : "Draft"} · ${cloud.statusLabel}${
      cloud.refreshing && cloud.live ? " · updating" : ""
    }`;
  })();
  const publishBarChipAction = resolvePublishBarChipAction({
    state: publishBarStatus.state,
    // An unpublished fork can still pull from its publisher — gating on
    // `live` alone hid "Update from publisher" on exactly those forks.
    live: cloud.live || isFork,
    syncEnabled: workspaceMode === "preview",
    pushing: webSyncPushing || Boolean(shareSyncNotice),
    pulling: webSyncPulling,
    pullingUpstream: upstreamPulling,
    publisherUpdatesAvailable: webSyncPublisherUpdatesAvailable,
    forkWebPreview,
  });
  const publishBarAction = resolvePublishBarPrimaryAction({
    state: publishBarStatus.state,
    hasLocalChanges: webSyncStatus?.hasLocalChanges === true,
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
    // Update result outranks idle chatter: the user just changed local files
    // and the outcome is the only thing they are waiting to read.
    if (upstreamNotice) {
      return {
        tone: upstreamNotice.tone === "ok" ? ("success" as const) : ("warn" as const),
        message: upstreamNotice.message,
      };
    }
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
    if (collabBar?.openProposeSheetOnChipClick) {
      setWebSyncPopoverOpen(false);
      openPropose();
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
      } else {
        // Previously swallowed: the button looked like it did nothing.
        cloud.reportError(publishErrorMessage(err));
      }
    } finally {
      setShareSyncNotice(null);
    }
  };

  const handleConfirmDesktopPublish = () => {
    setShareSyncNotice("Publishing to the web…");
    // Re-apply the audience from the sheet (incl. the "specific people"
    // allowlist). cloud.publish() re-used the saved sharing, so confirming a
    // first publish silently dropped the people you had just added.
    void applySharing(
      audience,
      permission,
      requireSignIn,
      perUserIsolation,
      allowedUserIds,
      allowedEmails,
      allowedEmailDomains,
      { acknowledgeDesktopOnly: true },
    )
      .then(async (result) => {
        if (!result.published && !cloud.live) {
          await cloud.publish({ acknowledgeDesktopOnly: true });
          setShareSyncNotice("Publishing app code and databases to the web…");
          await guardedWebSyncPushNow();
        }
        setNeedsDesktopAck(false);
      })
      .catch((err: unknown) => {
        if (err instanceof CloudPublishBlockedError) {
          cloud.clearError();
          setCompatReport(err.compatibility);
          setNeedsDesktopAck(true);
        } else {
          cloud.reportError(publishErrorMessage(err));
        }
      })
      .finally(() => {
        setShareSyncNotice(null);
      });
  };

  const handleWebSyncPushOrPublish = async (pullFirst = false) => {
    if (!cloud.live && isTrackCollaborator) {
      await guardedWebSyncPushNow();
      return;
    }
    if (!cloud.live) {
      await handlePublishClick();
      return;
    }
    // Web ahead + local edits: Updating… then Publishing…. A pull that hits
    // conflicts or fails stops here; the chip then shows what needs review.
    if (pullFirst) {
      const settled = await webSyncPullUpdates();
      if (!settled) return;
    }
    await guardedWebSyncPushNow();
  };

  /**
   * Pull from the publisher. Extracted from the old primary button so the chip
   * action can call it — a pull that silently rewrites local files needs to say
   * what it did, especially on conflicts where the user's edits were kept and
   * something still needs a decision.
   */
  const handleUpstreamPull = async (): Promise<boolean> => {
    setUpstreamPulling(true);
    setUpstreamNotice(null);
    let clean = false;
    try {
      const result = await pullTrackUpstream(appId);
      clean = result.conflictFiles.length === 0;
      setUpstreamNotice({
        tone: result.conflictFiles.length > 0 ? "warn" : "ok",
        message: formatTrackSyncSummary(result),
      });
      onTrackPullComplete?.();
      await webSyncRefresh(true);
    } catch (err) {
      setUpstreamNotice({
        tone: "bad",
        message: (err as Error).message.slice(0, 120),
      });
    } finally {
      setUpstreamPulling(false);
      setCollabEditsTick((n) => n + 1);
    }
    return clean;
  };

  const handleDiscardEdits = async () => {
    const who = cloudLineage?.sourceSlug ?? "the publisher";
    if (!confirm(`Discard your code edits and go back to ${who}'s latest code? Your data is not touched.`)) return;
    setUpstreamPulling(true);
    try {
      const result = await discardTrackLocalEdits(appId);
      setUpstreamNotice({ tone: "ok", message: `Back on ${who}'s code. ${formatTrackSyncSummary(result)}` });
      onTrackPullComplete?.();
      await webSyncRefresh(true);
    } catch (err) {
      setUpstreamNotice({ tone: "bad", message: (err as Error).message.slice(0, 120) });
    } finally {
      setUpstreamPulling(false);
      setCollabEditsTick((n) => n + 1);
    }
  };

  const handleDuplicateAsOwn = async (title: string) => {
    if (!cloudLineage) return;
    setUpstreamPulling(true);
    try {
      const copy = await duplicateAsOwnApp({
        namespaceId: cloudLineage.sourceNamespaceId,
        slug: cloudLineage.sourceSlug,
        title,
      });
      setDuplicateNameOpen(false);
      setUpstreamNotice({
        tone: "ok",
        message: `Created "${copy.title ?? "your copy"}" in Apps. It's yours to edit, publish and share.`,
      });
      onOpenDependencyApp?.(copy.appId, copy.title);
    } catch (err) {
      setUpstreamNotice({ tone: "bad", message: (err as Error).message.slice(0, 120) });
    } finally {
      setUpstreamPulling(false);
    }
  };

  const handleShowInFinder = () => {
    void gateway
      .send("memory:open-folder", { folderPath: `~/Papr/apps/${appId}` })
      .catch(() => undefined);
  };

  /** Collaborator Propose: Updating… first when the publisher is ahead, then
   *  the Propose sheet. Conflicts stop before anything is sent. */
  const handleCollaboratorPropose = async () => {
    if (collabBar?.primary.pullFirst) {
      const clean = await handleUpstreamPull();
      if (!clean) return;
    }
    openPropose();
  };

  const handleChipAction = () => {
    if (!publishBarChipAction) return;
    if (publishBarChipAction.kind === "updates") {
      void webSyncPullUpdates();
    } else if (publishBarChipAction.kind === "upstream") {
      void handleUpstreamPull();
    } else {
      handleWebSyncDotClick();
    }
  };

  return (
    <>
      <DuplicateAppNameModal
        open={duplicateNameOpen}
        sourceTitle={appTitle}
        busy={upstreamPulling}
        onCancel={() => setDuplicateNameOpen(false)}
        onConfirm={(title) => void handleDuplicateAsOwn(title)}
      />
      <CopyAppModal
        app={
          copyToWorkspaceOpen
            ? ({ id: appId, title: appTitle } as Artifact)
            : null
        }
        currentOrganizationId={currentOrganizationId}
        currentNamespaceId={papr.namespaceId}
        onClose={() => setCopyToWorkspaceOpen(false)}
        onCopied={() => undefined}
      />
      <div className="mini-app-publish-bar">
        <div className="mini-app-publish-bar__left">
          <div className="mini-app-publish-bar__meta">
            <PublishBarTitle
              appId={appId}
              title={appTitle}
              onRenamed={onTitleChange}
            />
            {/* Compatibility levels (Hybrid / Desktop only) no longer badge the
                bar — see CloudCompatibilityBadge. This stays mounted because it
                is also the only surface for "Papr Cloud paused". */}
            <CloudCompatibilityBadge
              report={compatReport ?? cloud.compatibility}
              loading={false}
            />
            {/* Lineage as a mark. Unlike the old text it survives the compact
                bar, where "whose app is this" is still worth answering. */}
            {lineageTitle ? (
              <span
                className="mini-app-publish-bar__lineage-mark"
                title={lineageTitle}
                aria-label={lineageTitle}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  {/* Two parents converging into one copy — reads as lineage at
                      13px, where a duplicated-page glyph reads as "copy" and a
                      branch arrow reads as "merge". */}
                  <circle cx="6" cy="5" r="2" />
                  <circle cx="18" cy="5" r="2" />
                  <circle cx="12" cy="19" r="2" />
                  <path d="M6 7v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7M12 11v6" />
                </svg>
                {/* Collaborator copies: fork + who they collaborate with
                    (people = team, globe = Community). A plain fork has no
                    second glyph: it is fully your own app. */}
                {lineageKind && lineageKind !== "fork" ? (
                  <ShareAudienceIcon
                    audience={lineageKind === "community" ? "public" : lineageKind}
                    loginAccess={lineageKind === "team" ? "team" : "public"}
                  />
                ) : null}
              </span>
            ) : null}
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
                  action={
                    collabBar
                      ? collabBar.chipAction
                        ? {
                            glyph: collabBar.chipAction.glyph,
                            verb: collabBar.chipAction.verb,
                            onRun: () =>
                              collabBar.chipAction?.kind === "upstream"
                                ? void handleUpstreamPull()
                                : openPropose(),
                          }
                        : undefined
                      : publishBarChipAction
                      ? {
                          glyph: publishBarChipAction.glyph,
                          verb: publishBarChipAction.verb,
                          onRun: handleChipAction,
                        }
                      : // Pull-from-publisher wins when both apply: take
                        // their changes first, then propose on top of them.
                        forkUnproposedEdits
                        ? {
                            glyph: "up" as const,
                            verb: "Propose",
                            onRun: openPropose,
                          }
                        : undefined
                  }
                />
              </span>
            ) : null}
          </div>

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
                    trackCollaborator={isTrackCollaborator}
                    sourceSlug={cloudLineage?.sourceSlug}
                    proposalWaiting={
                      collabBar?.chip.label === "Proposal sent"
                    }
                    onViewProposals={() => {
                      setWebSyncPopoverOpen(false);
                      openPropose();
                    }}
                    autoUploadEnabled={autoUploadEnabled}
                    onPushNow={() => void handleWebSyncPushOrPublish()}
                    onBumpQueue={() => void webSyncBumpQueue()}
                    onPullUpdates={() => void webSyncPullUpdates()}
                    onApplyRemoteUpdates={() => void webSyncApplyRemoteUpdates()}
                    onResolveConflict={(resolution) => void webSyncPullUpdates(resolution)}
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
            upstreamSlug={cloudLineage?.sourceSlug}
            // Propose never lives here now: it is the primary button for
            // collaborators and unshared forks, and the ▾ on Publish for
            // shared forks — the primary slot is the one place edits leave.
            onPropose={undefined}
            onDuplicateAsOwn={
              isTrackCollaborator ? () => setDuplicateNameOpen(true) : undefined
            }
            onDiscardEdits={
              isTrackCollaborator && collabLocalEdits
                ? () => void handleDiscardEdits()
                : undefined
            }
            onShowInFinder={handleShowInFinder}
            onCopyToWorkspace={
              papr.isLoggedIn ? () => setCopyToWorkspaceOpen(true) : undefined
            }
          />

          {showContributionsInbox ? (
            <button
              type="button"
              className="mini-app-publish-bar__button mini-app-publish-bar__button--icon"
              disabled={cloud.busy}
              aria-expanded={contributionsOpen}
              aria-label={`Contributions${
                contributionsBadgeCount > 0
                  ? `, ${contributionsBadgeCount} waiting for review`
                  : ""
              }`}
              title={
                contributionsBadgeCount > 0
                  ? `${contributionsBadgeCount} contribution${
                      contributionsBadgeCount === 1 ? "" : "s"
                    } waiting for review`
                  : incomingChanges.error
                    ? "Contributions — could not refresh list"
                    : "Contributions — review incoming proposals"
              }
              onClick={() => {
                void incomingChanges.reload();
                setContributionsOpen(true);
              }}
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
              {contributionsBadgeCount > 0 ? (
                <span className="mini-app-publish-bar__contributions-badge">
                  {contributionsBadgeCount}
                </span>
              ) : incomingChanges.error ? (
                <span
                  className="mini-app-publish-bar__contributions-badge mini-app-publish-bar__contributions-badge--warn"
                  aria-hidden
                >
                  !
                </span>
              ) : null}
            </button>
          ) : null}

          {/* An owner's draft has nothing to share yet, so Share waits until
              the app is live. A fork is fully your own app, so it gets the same
              plain Share (the sheet is where you publish it in the first place).
              The fork mark next to the title already says where it came from. */}
          {/* Collaborators (team or Community) get no Share: the app belongs
              to the publisher. To share it, use Duplicate as my own app in
              the menu, then share that copy. */}
          {!isTrackCollaborator && (cloud.live || isFork) ? (
            <button
              type="button"
              className={`mini-app-publish-bar__button${
                publishBarAction || proposeIsPrimary
                  ? ""
                  : " mini-app-publish-bar__button--primary"
              }`}
              disabled={cloud.busy}
              title={
                forkUnpublished
                  ? "Publish your own copy to the web"
                  : `Shared: ${cloud.statusLabel}`
              }
              onClick={() => setShareOpen(true)}
            >
              <ShareAudienceIcon
                audience={appliedModel.audience}
                loginAccess={cloud.loginAccess}
                codeAccess={cloud.codeAccess}
              />
              Share
            </button>
          ) : null}

          {/* Persistent, not a dismissible banner: unpublished work is a
              standing fact, and the action for it should not disappear. */}
          {collabBar ? (
            <button
              type="button"
              className="mini-app-publish-bar__button mini-app-publish-bar__button--primary"
              disabled={collabBar.primary.disabled || upstreamPulling}
              title={collabBar.primary.title}
              onClick={() => void handleCollaboratorPropose()}
            >
              {collabBar.primary.label}
            </button>
          ) : proposeIsPrimary ? (
            <button
              type="button"
              className="mini-app-publish-bar__button mini-app-publish-bar__button--primary"
              disabled={cloud.busy || upstreamPulling}
              title={`Send your edits to ${cloudLineage?.sourceSlug ?? "the publisher"} for review`}
              onClick={openPropose}
            >
              Propose
            </button>
          ) : publishBarAction ? (
            <div
              ref={proposeMenuRef}
              className={`mini-app-publish-bar__split${
                showProposeSplit ? " mini-app-publish-bar__split--on" : ""
              }`}
            >
            <button
              type="button"
              className={`mini-app-publish-bar__button mini-app-publish-bar__button--primary mini-app-publish-bar__split-main${
                publishBarAction.kind === "retry"
                  ? " mini-app-publish-bar__button--tone-bad"
                  : ""
              }`}
              // Disabled in place rather than unmounted: a button that vanishes
              // when there is nothing to publish reads the same as one hidden
              // by a mode switch, and absence cannot explain itself. The title
              // carries the reason.
              disabled={
                Boolean(publishBarAction.disabled) ||
                webSyncPushing ||
                webSyncPulling ||
                upstreamPulling ||
                cloud.busy
              }
              title={publishBarAction.title}
              onClick={() => {
                // Armed here, fired by the effect once the push actually
                // finishes clean — pushNow swallows its own errors, so
                // awaiting it cannot tell success from failure.
                proposeOfferArmedRef.current = showProposeSplit;
                void handleWebSyncPushOrPublish(publishBarAction.pullFirst === true);
              }}
            >
              {publishBarAction.label}
            </button>
            {showProposeSplit && cloudLineage ? (
              <>
                {/* Not tied to publishBarAction.disabled. Whether your copy
                    differs from the publisher is a separate question from
                    whether you have unpublished edits, and the app cannot
                    answer it yet — so the ▾ stays live. TODO: grey it (with a
                    reason) once a fork-vs-upstream diff signal exists; the
                    Propose sheet does not yet say "nothing to send" either. */}
                <button
                  type="button"
                  className="mini-app-publish-bar__button mini-app-publish-bar__button--primary mini-app-publish-bar__split-caret"
                  aria-haspopup="menu"
                  aria-expanded={proposeMenuOpen}
                  aria-label={`More ways to send changes, including propose to ${cloudLineage.sourceSlug}`}
                  title={`Propose to ${cloudLineage.sourceSlug}`}
                  disabled={cloud.busy || upstreamPulling}
                  onClick={() => setProposeMenuOpen((v) => !v)}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                {proposeMenuOpen ? (
                  <div
                    className="pb-overflow__menu mini-app-publish-bar__split-menu"
                    role="menu"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="pb-overflow__item"
                      onClick={() => {
                        setProposeMenuOpen(false);
                        openPropose();
                      }}
                    >
                      Propose to {cloudLineage.sourceSlug}
                      <span className="pb-overflow__hint">
                        Send your edits to the publisher for review
                      </span>
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {showContributionsInbox && contributionsOpen ? (
        <ShareSheet
          wide
          title={contributionCopy.title}
          onClose={() => setContributionsOpen(false)}
        >
          <div className="share-sheet__panel share-sheet__panel--contributions">
            <p className="share-sheet__section-desc share-sheet__section-desc--lead">
              {contributionCopy.description}
            </p>
            <CloudChangeRequestsPanel
              busy={cloud.busy}
              variant="modal"
              shareAudience={audience}
              appPublished={cloud.live}
              showHeader={false}
              requests={incomingChanges.requests}
              pending={incomingChanges.open}
              loading={incomingChanges.loading}
              error={incomingChanges.error}
              onReload={incomingChanges.reload}
            />
          </div>
        </ShareSheet>
      ) : null}

      {workspaceMode === "preview" &&
      webSyncActionNotice ? (
        <div
          className="mini-app-publish-bar__action-callout"
          // An offer is not an alarm — only review/failed interrupt.
          role={webSyncActionKind === "propose" ? "status" : "alert"}
          aria-live="polite"
        >
          <span className="mini-app-publish-bar__action-callout-text">
            {webSyncActionNotice}
          </span>
          {/* Review/failed get no action button: the bar's primary already
              offers it persistently. Propose is the exception — its only other
              home on a shared fork is the ▾, which is easy to miss. */}
          {webSyncActionKind === "propose" ? (
            <button
              type="button"
              className="mini-app-publish-bar__action-callout-btn"
              onClick={() => {
                setWebSyncActionNotice(null);
                openPropose();
              }}
            >
              Propose
            </button>
          ) : webSyncStatus ? (
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

      {proposeOpen && cloudLineage ? (
        <ShareSheet
          title={`Propose to ${cloudLineage.sourceSlug}`}
          onClose={() => setProposeOpen(false)}
        >
          <div className="share-sheet__panel">
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
          </div>
        </ShareSheet>
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

                    {/* Attached to its own option rather than appended after
                        the whole list. Rendered after </ul> it sat below
                        "Public in Community Apps", so it read as a setting
                        belonging to that option instead of to this one. */}
                    {option.value === "people" && audience === "people" ? (
                      <div className="share-sheet__people">
                        <SharePeoplePicker
                          members={workspacePeople}
                          value={allowedUserIds}
                          onChange={setAllowedUserIds}
                          allowedEmails={allowedEmails}
                          allowedEmailDomains={allowedEmailDomains}
                          onEmailsChange={setAllowedEmails}
                          onDomainsChange={setAllowedEmailDomains}
                          loading={workspacePeopleLoading}
                          disabled={shareSheetBusy}
                          currentUserId={workspaceSelfId}
                        />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
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
                  disabled={shareSheetBusy || peopleAllowlistEmpty}
                  onClick={saveSharingSettings}
                  title={
                    peopleAllowlistEmpty
                      ? "Add at least one workspace member, email, or domain — or pick a different audience"
                      : undefined
                  }
                >
                  {shareSheetBusy
                    ? "Saving…"
                    : peopleAllowlistEmpty
                      ? "Add an allowlist entry to save"
                      : "Save sharing settings"}
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

            {/* Contribute-back lives in its own Propose sheet — Share is only
                about who can reach your copy. */}

            {/* Scope is per key in this panel, which is why the tab summary
                says "Per key" rather than one global owner/visitor answer. */}
            {shareStep === "keys" && audience !== "private" ? (
              <CloudAppCredentialsPanel
                appId={appId}
                appTitle={appTitle}
                busy={cloud.busy}
                appLive={cloud.live}
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
              <div ref={desktopAckRef}>
              <CloudCompatibilityPanel
                report={compatReport ?? cloud.compatibility}
                loading={compatLoading}
                showConfirm={needsDesktopAck}
                confirmBusy={cloud.busy}
                onConfirmPublish={handleConfirmDesktopPublish}
              />
              </div>
            ) : null}
          </div>
        </ShareSheet>
      ) : null}
    </>
  );
}
