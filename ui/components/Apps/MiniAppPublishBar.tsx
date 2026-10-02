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
  webSyncVisualState,
} from "../../utils/appCloudSyncStatus";
import {
  discardTrackLocalEdits,
  detachFromOriginal,
  duplicateAsOwnApp,
  describeDuplicateError,
  fetchTrackLocalEdits,
  formatTrackSyncSummary,
  pullTrackUpstream,
} from "../../utils/cloudTrackSyncApi";
import { listSentProposals } from "../../utils/cloudContributeApi";
import {
  copyAxesFromLineage,
  deriveCopyState,
  resolveCopyBar,
  usesSharedData,
  type CopyChipAction,
} from "../../utils/copyState";
import {
  collaboratorProposalStatusFromSent,
  type CollaboratorLatestProposalStatus,
} from "../../utils/appCloudSyncStatus";
import {
  resolveEffectiveAutoUpload,
} from "../../utils/appUploadMode";
import { audienceModelNeedsInitialCodeUpload } from "../../utils/cloudPublishRouting";
import {
  SharePeoplePicker,
  type SharePeopleMember,
} from "./SharePeoplePicker";
import {
  isPermissionAvailable,
  publishPrefsToAudienceModel,
  shareAudienceHasPeopleRestriction,
  type ShareAudience,
  type ShareAudienceModel,
  type SharePermission,
} from "../../utils/shareAudienceModel";
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
import { ShareSheetBody } from "./ShareSheetBody";
import { openKeySettings, useMissingAppKeys } from "../../hooks/useMissingAppKeys";
import {
  resolveSharingPatch,
  missingKeysLabel,
  missingKeysTone,
  sameSharing,
  sharingConfirmPrompt,
  type ShareStepId,
  type SharingDraft,
  type SharingPatch,
} from "../../utils/shareSheetModel";
import { PublishBarOverflowMenu } from "./PublishBarOverflowMenu";
import { AppWorkspacePanelMenu } from "./AppWorkspacePanelMenu";
import {
  WebSyncPopover,
  WebSyncStatusDot,
  ShareAudienceIcon,
  buildGenericSyncAgentPrompt,
} from "./WebSyncPopover";
import {
  buildContributorProposalUpdateAgentPrompt,
  openCloudSyncAgentChat,
} from "../../utils/openCloudSyncAgentChat";
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
  /** Lets the missing-key chip open Share straight on the keys step. */
  const [shareInitialStep, setShareInitialStep] = useState<ShareStepId | null>(null);
  const [keysCheckToken, setKeysCheckToken] = useState(0);
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

  const isTrackCollaborator = cloudLineage?.mode === "track";
  const cloudPublishFailedEarly = Boolean(cloud.errorDetail) && !needsDesktopAck;
  // v5: the data decides the button. Only a linked team copy on the team's
  // live data proposes; every other copy is the user's own and publishes to
  // its own link (proposing is one step away, on the split caret).
  const copyAxes = cloudLineage ? copyAxesFromLineage(cloudLineage) : null;
  const onTeamData = copyAxes?.link === "linked" && copyAxes.dataMode === "team";
  /** "Mine" keys missing from the owner's keychain — a status, not a setting.
   *  Only the owner of a live app pays for "Mine", so only they see it. */
  const missingKeys = useMissingAppKeys(
    appId,
    cloud.live && !onTeamData,
    keysCheckToken,
  );
  const missingTone = missingKeysTone(missingKeys);
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
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
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
  // A proposal sent from anywhere (agent tool, another tab) re-reads the chip.
  useEffect(() => {
    const onBroadcast = (event: Event) => {
      const d = (event as CustomEvent).detail as
        | { type?: string; data?: { appId?: string } }
        | undefined;
      if (d?.type !== "cloud-sync:items-stale") return;
      if (d.data?.appId && d.data.appId !== appId) return;
      setCollabEditsTick((n) => n + 1);
    };
    window.addEventListener("gateway-broadcast", onBroadcast);
    return () => window.removeEventListener("gateway-broadcast", onBroadcast);
  }, [appId]);
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
      // Superseded rows are history; the newest live proposal drives the chip.
      const newest = rows.find((r) => r.status !== "superseded");
      setLatestProposalStatus(collaboratorProposalStatusFromSent(newest));
    });
    return () => {
      cancelled = true;
    };
  }, [appId, isTrackCollaborator, proposeOpen, collabEditsTick]);
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

  const webDisplayUrl = onTeamData
    ? upstreamWebUrl
    : cloud.publishedWebUrl ?? cloud.shareUrl;
  const copyUrl = onTeamData
    ? upstreamWebUrl
    : cloud.externalLinkUrl ?? cloud.loginUrl ?? webDisplayUrl;
  /** Shareable web URL only — never localhost (misleading when previewing locally). */
  const previewDisplayUrl = onTeamData
    ? upstreamWebUrl
    : cloud.live
      ? (copyUrl ?? webDisplayUrl)
      : null;
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

  const takeOffWeb = () => {
    void cloud.unpublish();
    setShareOpen(false);
  };

  const canOpenWebPreview = onTeamData
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
  // v5: one resolver for every installed copy. Chip, primary kind and badge
  // all come from resolveCopyBar(deriveCopyState(...)); nothing else in the
  // bar decides them for a copy.
  const copyBar = cloudLineage
    ? resolveCopyBar(
        deriveCopyState(cloudLineage, {
          live: cloud.live,
          hasLocalEdits: collabLocalEdits,
          hasUnproposedEdits: collabUnproposed,
          hasUnpublishedEdits: webSyncStatus?.hasLocalChanges === true,
          publisherAhead: webSyncPublisherUpdatesAvailable,
          pullState: upstreamPulling
            ? "pulling"
            : webSyncState === "action_required"
              ? "conflict"
              : "idle",
          lastPublishFailed: cloudPublishFailedEarly,
          proposal: latestProposalStatus ?? "none",
          busy: cloud.busy,
        }),
      )
    : null;
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
  // v5: an unpublished copy on its own data is a draft like any owned app
  // (chip "Draft", primary Publish), not "Edits not proposed".
  const forkUnproposedEdits = false;
  // Where local edits go: a collaborator (track) or an unpublished fork sends
  // them upstream for review; publishing your own copy lives under Share.
  const proposeIsPrimary = copyBar?.primary.kind === "propose";
  // A shared fork has two destinations: its own web copy (the common case,
  // reversible — so the default click) and the publisher (occasional, lands
  // in someone else's queue — so one deliberate step away on the ▾). The two
  // halves have independent enabled states: right after you publish, Publish
  // has nothing left to send, which is exactly when Propose is most wanted.
  const showProposeSplit = isFork && !onTeamData && Boolean(cloudLineage);
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
  // Own-data copies keep the web-sync chip (Draft / Newer version on web /
  // Checking…) unless the copy resolver has something about the original to
  // say. Team-data copies always show the copy chip.
  const copyChipWins =
    copyBar != null &&
    (onTeamData ||
      (copyBar.chip.action != null &&
        copyBar.chip.action !== "publish" &&
        copyBar.chip.action !== "retry_publish") ||
      copyBar.chip.tone === "busy");
  const copyChipState = (tone: string): typeof publishBarStatus.state =>
    tone === "bad"
      ? "error"
      : tone === "warn"
        ? "warn"
        : tone === "info"
          ? "updates_available"
          : tone === "busy"
            ? "syncing"
            : "synced";
  const publishBarChip = copyChipWins && copyBar
    ? { label: copyBar.chip.label, showRefresh: false, tone: copyBar.chip.tone }
    : !copyBar && forkChipOverrides
    ? {
        label: forkUpstreamChip.label,
        showRefresh: false,
        tone: forkUpstreamChip.tone,
      }
    : forkUnproposedEdits
      ? { label: "Edits not proposed", showRefresh: false, tone: "warn" as const }
      : publishBarChipBase;
  const publishBarChipState = copyChipWins && copyBar
    ? copyChipState(copyBar.chip.tone)
    : !copyBar && forkChipOverrides
    ? forkUpstreamChip.state
    : forkUnproposedEdits
      ? ("warn" as const)
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
  // Badge comes from the copy resolver: linked → origin (person = team,
  // globe = Community); detached → fork mark only.
  const copyBadge = copyBar?.badge ?? null;
  const lineageKind: "fork" | "team" | "people" | "community" | null = !cloudLineage || !copyBadge
    ? null
    : copyBadge.kind === "fork_mark"
      ? "fork"
      : copyBadge.icon === "globe"
        ? "community"
        : cloudLineage.sourceAudience === "people"
          ? "people"
          : "team";
  const ownDataTail = "Your own data. Publish puts your copy at its own link; you can still get updates and propose edits.";
  const lineageTitle = !cloudLineage
    ? null
    : lineageKind === "team"
      ? onTeamData
        ? `Team app from ${cloudLineage.sourceSlug}. You're on the team's data; your code edits go to the owner as proposals.`
        : `Your copy of ${cloudLineage.sourceSlug}'s team app. ${ownDataTail}`
      : lineageKind === "people"
      ? onTeamData
        ? `Shared with you by the owner of ${cloudLineage.sourceSlug}. You're on their data; code edits go as proposals.`
        : `Your copy of ${cloudLineage.sourceSlug}. ${ownDataTail}`
      : lineageKind === "community"
        ? `Your copy of ${cloudLineage.sourceSlug} from Community. ${ownDataTail}`
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
    if (
      copyBar?.chip.action === "view_proposal" ||
      copyBar?.chip.action === "see_decline" ||
      (onTeamData && copyBar?.chip.action === "propose")
    ) {
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

  /** v6 Share: narrowing saves the moment it is picked; opening the app up
   *  waits for one inline confirm (sharingConfirmPrompt). Share is live-only —
   *  the bar's Publish is how an app gets on the web. */
  const sharingDraft: SharingDraft = {
    audience,
    permission,
    requireSignIn,
    perUserIsolation,
  };
  const savedSharing: SharingDraft = {
    audience: appliedModel.audience,
    permission: appliedModel.permission,
    requireSignIn: appliedRequireSignIn,
    perUserIsolation: appliedPerUserIsolation,
  };
  const reportSharingError = (err: unknown) =>
    cloud.reportError(publishErrorMessage(err));
  const showSharing = (next: SharingDraft) => {
    setAudience(next.audience);
    setPermission(next.permission);
    setRequireSignIn(next.requireSignIn);
    setPerUserIsolation(next.perUserIsolation);
  };
  const saveSharing = (next: SharingDraft) => {
    if (!cloud.live || sameSharing(next, savedSharing)) return;
    // An empty "Specific people" list would save as the whole workspace —
    // hold the change until someone is added.
    if (
      next.audience === "people" &&
      !shareAudienceHasPeopleRestriction({
        allowedUserIds,
        allowedEmails,
        allowedEmailDomains,
      })
    ) {
      return;
    }
    applySharing(
      next.audience,
      next.permission,
      next.requireSignIn,
      next.perUserIsolation,
    ).catch(reportSharingError);
  };
  const changeSharing = (patch: SharingPatch) => {
    if (shareSheetBusy) return;
    const next = resolveSharingPatch(sharingDraft, patch);
    showSharing(next);
    if (next.audience === "people") void ensureWorkspacePeople();
    // Compared against what is live, so stepping through options and back
    // never asks, and the question always describes the real change.
    if (sharingConfirmPrompt(savedSharing, next)) return;
    saveSharing(next);
  };
  const pendingSharingConfirm = sameSharing(sharingDraft, savedSharing)
    ? null
    : sharingConfirmPrompt(savedSharing, sharingDraft);
  const confirmPendingSharing = () => saveSharing(sharingDraft);
  const cancelPendingSharing = () => {
    if (pendingSharingConfirm) showSharing(savedSharing);
  };
  const changePeople = (ids: string[], emails: string[], domains: string[]) => {
    setAllowedUserIds(ids);
    setAllowedEmails(emails);
    setAllowedEmailDomains(domains);
    const restricted = shareAudienceHasPeopleRestriction({
      allowedUserIds: ids,
      allowedEmails: emails,
      allowedEmailDomains: domains,
    });
    if (!cloud.live || shareSheetBusy || !restricted) return;
    applySharing(
      audience,
      permission,
      requireSignIn,
      perUserIsolation,
      ids,
      emails,
      domains,
    ).catch(reportSharingError);
  };
  const shareLinkHint =
    cloud.live && (copyUrl || webDisplayUrl) && !shareLinkReady
      ? cloud.externalLink !== "off" && !(copyUrl ?? "").includes("?t=")
        ? "Invite token appears once the upload finishes."
        : "May show \"not found\" until the upload finishes."
      : null;

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
    // Team-data copies never publish (their code goes by proposal); push
    // keeps their shared rows flowing. Every other copy publishes itself.
    if (!cloud.live && onTeamData) {
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

  const handleDetach = async () => {
    const who = cloudLineage?.sourceSlug ?? "the original";
    if (!confirm(`Detach from ${who}? You keep your copy and data, but won't get ${who}'s updates or be able to propose changes. This can't be undone.`)) return;
    try {
      await detachFromOriginal(appId);
      setUpstreamNotice({ tone: "ok", message: `Detached from ${who}. This copy is fully yours now.` });
      onTrackPullComplete?.();
      await webSyncRefresh(true);
    } catch (err) {
      setUpstreamNotice({ tone: "bad", message: (err as Error).message.slice(0, 120) });
    }
  };

  const handleDuplicateAsOwn = async (title: string) => {
    if (!cloudLineage) return;
    setUpstreamPulling(true);
    setDuplicateError(null);
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
      // Keep the dialog open and say why: the bar's notice only renders inside
      // the Share sheet, so failures here used to look like nothing happened.
      setDuplicateError(describeDuplicateError((err as Error).message));
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
    // Publisher ahead: get their changes first so the proposal sits on top.
    if (onTeamData && webSyncPublisherUpdatesAvailable) {
      const clean = await handleUpstreamPull();
      if (!clean) return;
    }
    openPropose();
  };

  /** Stale proposal: get the publisher's latest, then propose again (the new
   *  proposal replaces the old one). Overlapping files go to the agent. */
  const handleUpdateAndRepropose = async () => {
    setUpstreamPulling(true);
    setUpstreamNotice(null);
    try {
      const result = await pullTrackUpstream(appId);
      onTrackPullComplete?.();
      await webSyncRefresh(true);
      if (result.conflictFiles.length > 0) {
        setUpstreamNotice({
          tone: "warn",
          message: `Your edits overlap theirs in ${result.conflictFiles.join(", ")} — opened the agent to combine them.`,
        });
        openCloudSyncAgentChat(
          buildContributorProposalUpdateAgentPrompt({
            appId,
            sourceSlug: cloudLineage?.sourceSlug ?? "the publisher",
            conflictFiles: result.conflictFiles,
          }),
        );
        return;
      }
      setUpstreamNotice({
        tone: "ok",
        message: "Up to date with the publisher — send your proposal again.",
      });
      openPropose();
    } catch (err) {
      setUpstreamNotice({ tone: "bad", message: (err as Error).message.slice(0, 120) });
    } finally {
      setUpstreamPulling(false);
      setCollabEditsTick((n) => n + 1);
    }
  };

  const runCopyChipAction = (action: CopyChipAction | null) => {
    switch (action) {
      case "get_updates":
        void handleUpstreamPull();
        return;
      case "update_and_repropose":
        void handleUpdateAndRepropose();
        return;
      case "review_conflicts":
        handleWebSyncDotClick();
        return;
      case "publish":
      case "retry_publish":
        void handleWebSyncPushOrPublish();
        return;
      case "propose":
      case "see_decline":
      case "view_proposal":
        openPropose();
        return;
      default:
        return;
    }
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
        error={duplicateError}
        onCancel={() => {
          setDuplicateNameOpen(false);
          setDuplicateError(null);
        }}
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
                    copyChipWins && copyBar
                      ? copyBar.chip.action && copyBar.chip.verb
                        ? {
                            glyph:
                              copyBar.chip.action === "get_updates" ||
                              copyBar.chip.action === "update_and_repropose"
                                ? ("down" as const)
                                : copyBar.chip.action === "propose"
                                  ? ("up" as const)
                                  : ("open" as const),
                            verb: copyBar.chip.verb,
                            onRun: () => runCopyChipAction(copyBar.chip.action),
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
                      copyBar?.chip.label === "Proposal sent"
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
            // Detach is only offered off team data; a team-data copy must
            // switch to its own data first (the gateway refuses otherwise).
            onDetach={
              isTrackCollaborator && !usesSharedData(cloudLineage) ? () => void handleDetach() : undefined
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
          {missingTone ? (
            <button
              type="button"
              className={`mini-app-publish-bar__keys-chip mini-app-publish-bar__keys-chip--${missingTone}`}
              title={`${missingKeys.map((k) => k.name).join(", ")} ${
                missingKeys.length === 1 ? "is" : "are"
              } set to Mine but not on your account${
                missingTone === "bad"
                  ? ". People can't use the app until it's added."
                  : ". Optional features won't work for people."
              }`}
              onClick={() => {
                setShareInitialStep("keys");
                setShareOpen(true);
              }}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
                <path
                  d="M10 2.5a3.5 3.5 0 1 1-2.9 5.5L2.5 12.6v1.9h2v-1.5h1.5V11.5h1.5l.9-.9A3.5 3.5 0 0 1 10 2.5Zm1 2.6h.01"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {missingKeysLabel(missingKeys)}
            </button>
          ) : null}

          {!onTeamData && cloud.live ? (
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
          {copyBar?.primary.kind === "propose" ? (
            <button
              type="button"
              className="mini-app-publish-bar__button mini-app-publish-bar__button--primary"
              disabled={copyBar.primary.disabled}
              title={copyBar.primary.title}
              onClick={() => void handleCollaboratorPropose()}
            >
              {copyBar.primary.label}
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
          onClose={() => {
            cancelPendingSharing();
            setShareOpen(false);
            setShareInitialStep(null);
          }}
        >
          <ShareSheetBody
            appId={appId}
            appTitle={appTitle}
            draft={sharingDraft}
            onChange={changeSharing}
            peoplePicker={
              <SharePeoplePicker
                members={workspacePeople}
                value={allowedUserIds}
                onChange={(ids) => changePeople(ids, allowedEmails, allowedEmailDomains)}
                allowedEmails={allowedEmails}
                allowedEmailDomains={allowedEmailDomains}
                onEmailsChange={(emails) =>
                  changePeople(allowedUserIds, emails, allowedEmailDomains)
                }
                onDomainsChange={(domains) =>
                  changePeople(allowedUserIds, allowedEmails, domains)
                }
                loading={workspacePeopleLoading}
                disabled={shareSheetBusy}
                currentUserId={workspaceSelfId}
              />
            }
            linkUrl={cloud.live ? (copyUrl ?? webDisplayUrl ?? null) : null}
            linkHint={shareLinkHint}
            onCopyLink={() => void cloud.copyLink(copyUrl ?? webDisplayUrl)}
            onOpenLink={() => void cloud.openInBrowser(copyUrl ?? webDisplayUrl)}
            busy={shareSheetBusy}
            peopleAllowlistEmpty={peopleAllowlistEmpty}
            pendingConfirm={pendingSharingConfirm}
            onConfirmPending={confirmPendingSharing}
            onCancelPending={cancelPendingSharing}
            missingKeys={missingKeys}
            onAddMissingKeys={openKeySettings}
            onKeysSaved={() => setKeysCheckToken((n) => n + 1)}
            initialEdit={shareInitialStep}
            notices={
              <>
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
                  </div>
                ) : null}
                {isFork ? (
                  <div className="share-sheet__notice share-sheet__notice--info">
                    <p>
                      <strong>Your copy</strong> — sharing here puts <em>your</em> fork
                      on the web. It does not change the team&apos;s shared app.
                    </p>
                  </div>
                ) : null}
                <CloudPublishDependenciesPanel
                  readiness={readiness}
                  loading={readinessLoading}
                  onOpenDependencyApp={onOpenDependencyApp}
                />
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
              </>
            }
          />
        </ShareSheet>
      ) : null}
    </>
  );
}
