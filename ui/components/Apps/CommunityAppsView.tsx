/**
 * CommunityAppsView - Browse Papr Cloud + open-source community apps
 */

import { useState, useEffect, useCallback } from "react";
import { gateway } from "../../src/lib/gateway";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useChat } from "../../hooks/useChat";
import { useTabs } from "../../hooks/useTabs";
import {
  ImportSetupWizard,
  type WizardResult,
  type HelpRequest,
} from "./ImportSetupWizard";
import type { CommunityCatalogEntry, CommunityCatalogScope } from "../../../src/core/types/communityCatalog";
import { isTeamSharedVisibility } from "../../../src/core/types/communityCatalog";
import type { RequirementItem, RequiredKeySpec } from "../../../src/core/types/bundles";
import { normalizeRequirements } from "../../../src/core/types/bundles";
import { lookupService } from "../../../src/core/data/knownServices";
import "./CommunityAppsView.css";
import { trackEvent } from "../../lib/telemetry";
import {
  canInstallCloudCatalogEntry,
  cloudSourceKey,
  resolveLocalAppIdForCatalogEntry,
  type CloudLineageIndex,
} from "../../utils/communityAppLocalOpen";
import {
  readCommunityCatalogCache,
  writeCommunityCatalogCache,
} from "../../utils/communityCatalogCache";
import { isWorkspaceSwitchReloading } from "../../lib/workspaceSwitchReload";
import {
  filterCatalogDisplayTags,
  getCatalogByline,
  getCatalogShareBadge,
} from "../../utils/communityCatalogDisplay";
import {
  shouldShowInCommunityBrowse,
  sortCommunityEntriesInstallableFirst,
} from "../../utils/communityCatalogBrowseFilter";
import {
  resolveCatalogLiveWebUrl,
  resolveCatalogPreviewIframeUrl,
} from "../../utils/catalogPreviewUrl";
import { prefetchCloudPreviewSession } from "../../utils/cloudPreviewSession";
import {
  cloudCatalogPreviewEntityId,
  type CloudCatalogPreviewTabMetadata,
} from "../../types/cloudCatalogPreviewTab";
import { CloudCatalogInstallModal } from "./CloudCatalogInstallModal";

const GATEWAY =
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

type CloudInstallMode = "fork" | "track";

interface CommunityCatalog {
  schemaVersion: string;
  scope: CommunityCatalogScope;
  entries: CommunityCatalogEntry[];
  sources: {
    opensource: number;
    cloud: number;
  };
  fallbackUsed?: boolean;
  namespaceId?: string;
}

export interface CommunityAppsViewProps {
  scope?: CommunityCatalogScope;
  namespaceId?: string | null;
  namespaceName?: string | null;
  /** When set, search is controlled by AppsView topbar */
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
  /** Hide inline toolbar — parent renders search in shared topbar */
  hideToolbar?: boolean;
  /** Increment to refetch catalog from parent refresh button */
  refreshToken?: number;
  /** Shown while the catalog is loading (defaults from scope). */
  loadingLabel?: string;
}

function defaultLoadingLabel(scope: CommunityCatalogScope): string {
  return scope === "namespace" ? "Loading team apps..." : "Loading community apps...";
}

function emptyMessage(
  scope: CommunityCatalogScope,
  searchQuery: string,
  namespaceName: string | null | undefined,
): string {
  if (searchQuery) return "No apps match your search.";
  if (scope === "namespace") {
    const label = namespaceName?.trim() || "your workspace";
    return `No team or public apps in ${label} yet. Share an app with My team from its share settings — your published team apps appear here too.`;
  }
  return "No community apps available yet.";
}

function namespaceSummary(
  entries: CommunityCatalogEntry[],
  namespaceName: string | null | undefined,
): string {
  const label = namespaceName?.trim() || "workspace";
  const teamCount = entries.filter((entry) => isTeamSharedVisibility(entry.visibility)).length;
  const publicCount = entries.length - teamCount;
  const parts: string[] = [];
  if (teamCount > 0) {
    parts.push(`${teamCount} team-shared`);
  }
  if (publicCount > 0) {
    parts.push(`${publicCount} public`);
  }
  if (parts.length === 0) return `Nothing in ${label} yet`;
  return `${parts.join(" · ")} in ${label}`;
}

function catalogSummaryLine(
  scope: CommunityCatalogScope,
  catalog: CommunityCatalog,
  namespaceName: string | null | undefined,
  refreshing: boolean,
  fallbackSuffix: string,
): string | null {
  if (scope === "namespace") {
    let text = namespaceSummary(catalog.entries, namespaceName);
    if (catalog.fallbackUsed) {
      text += fallbackSuffix;
    }
    if (refreshing) {
      text += " · updating…";
    }
    return text;
  }
  return refreshing ? "Updating…" : null;
}

/** Legacy shape for ImportSetupWizard */
interface OssRegistryEntry {
  bundleId: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  minPaprworkVersion: string;
  path: string;
  icon?: string;
  requirements?: RequirementItem[];
  platform?: string[];
}

function sanitizeIcon(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/on\w+\s*=/gi, "data-blocked=");
}

function detectUserPlatform(): "macos" | "windows" | "linux" {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  return "linux";
}

function isCloudEntryInstalled(
  entry: CommunityCatalogEntry,
  installedAppIds: Set<string>,
  lineageIndex: CloudLineageIndex | null,
): boolean {
  if (!entry.appId) return false;
  if (installedAppIds.has(entry.appId)) return true;
  if (!entry.namespaceId || !entry.slug || !lineageIndex) return false;
  const key = cloudSourceKey(entry.namespaceId, entry.slug);
  return (lineageIndex.bySourceKey[key]?.length ?? 0) > 0;
}

function installedForkCountForEntry(
  entry: CommunityCatalogEntry,
  lineageIndex: CloudLineageIndex | null,
): number {
  if (!entry.namespaceId || !entry.slug || !lineageIndex) return 0;
  const key = cloudSourceKey(entry.namespaceId, entry.slug);
  return lineageIndex.bySourceKey[key]?.length ?? 0;
}

function userProvidedRequirements(
  reqs: RequirementItem[] | RequiredKeySpec[] | undefined,
): RequiredKeySpec[] {
  if (!reqs?.length) return [];
  return normalizeRequirements(reqs).filter(
    (spec) => spec.required !== false && spec.credentialScope !== "owner",
  );
}

function toOssEntry(entry: CommunityCatalogEntry): OssRegistryEntry {
  return {
    bundleId: entry.bundleId ?? entry.catalogId,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    author: entry.author,
    tags: entry.tags,
    minPaprworkVersion: entry.minPaprworkVersion ?? "2.0.0",
    path: entry.path ?? "",
    icon: entry.icon,
    requirements: entry.requirements,
    platform: entry.platform,
  };
}

export function CommunityAppsView({
  scope = "global",
  namespaceId = null,
  namespaceName = null,
  searchQuery: searchQueryProp,
  onSearchQueryChange,
  hideToolbar = false,
  refreshToken = 0,
  loadingLabel,
}: CommunityAppsViewProps) {
  const [catalog, setCatalog] = useState<CommunityCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [internalSearchQuery, setInternalSearchQuery] = useState("");
  const searchQuery = searchQueryProp ?? internalSearchQuery;
  const setSearchQuery = onSearchQueryChange ?? setInternalSearchQuery;
  const [showAllPlatforms, setShowAllPlatforms] = useState(false);
  const [wizardEntry, setWizardEntry] = useState<OssRegistryEntry | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installToast, setInstallToast] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [lineageIndex, setLineageIndex] = useState<CloudLineageIndex | null>(null);
  const [installModeEntry, setInstallModeEntry] = useState<CommunityCatalogEntry | null>(null);
  const [cloudInstallWizard, setCloudInstallWizard] = useState<{
    appId: string;
    appTitle: string;
    requirements: RequiredKeySpec[];
  } | null>(null);
  const { artifacts, loadArtifacts } = useArtifacts();
  const { createChat } = useChat();
  const { createTab, switchToTab } = useTabs();
  const userPlatform = detectUserPlatform();
  const catalogLoadingLabel = loadingLabel ?? defaultLoadingLabel(scope);

  const installedAppIds = new Set(
    artifacts.filter((artifact) => artifact.type === "app").map((artifact) => artifact.id),
  );

  const loadCatalog = useCallback(
    async (options?: { forceRefresh?: boolean; isStale?: () => boolean }) => {
      const forceRefresh = options?.forceRefresh === true;
      const isStale = options?.isStale ?? (() => false);

      if (!forceRefresh && isWorkspaceSwitchReloading()) {
        return;
      }

      const cached = !forceRefresh
        ? readCommunityCatalogCache(scope, namespaceId)
        : null;

      if (isStale()) {
        return;
      }

      if (cached && (!namespaceId || cached.namespaceId === namespaceId)) {
        setCatalog(cached);
        setLoading(false);
        setRefreshing(true);
        setError(null);
      } else {
        setCatalog(null);
        setLoading(true);
        setRefreshing(false);
        setError(null);
      }

      try {
        const response = await gateway.send(
          "bundle:fetch-community-catalog",
          {
            scope,
            ...(namespaceId ? { namespaceId } : {}),
            ...(forceRefresh ? { forceRefresh: true } : {}),
          },
          scope === "namespace" ? { timeoutMs: 60_000 } : undefined,
        );
        if (isStale()) {
          return;
        }
        const nextCatalog = response.data as CommunityCatalog;
        setCatalog(nextCatalog);
        writeCommunityCatalogCache(scope, namespaceId, nextCatalog);
        setError(null);
      } catch (err) {
        if (isStale()) {
          return;
        }
        if (!cached) {
          setError(
            err instanceof Error ? err.message : "Failed to load community apps",
          );
        }
      } finally {
        if (!isStale()) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [scope, namespaceId],
  );

  useEffect(() => {
    let stale = false;
    void loadCatalog({ isStale: () => stale });
    return () => {
      stale = true;
    };
  }, [loadCatalog]);

  useEffect(() => {
    const onSwitchStart = (): void => {
      setCatalog(null);
      setLoading(true);
      setRefreshing(false);
      setError(null);
    };
    const onSwitchComplete = (): void => {
      void loadCatalog({ forceRefresh: true });
    };
    window.addEventListener("papr-workspace-switch-start", onSwitchStart);
    window.addEventListener("papr-workspace-switch-complete", onSwitchComplete);
    return () => {
      window.removeEventListener("papr-workspace-switch-start", onSwitchStart);
      window.removeEventListener(
        "papr-workspace-switch-complete",
        onSwitchComplete,
      );
    };
  }, [loadCatalog]);

  useEffect(() => {
    setCatalog(null);
    setLoading(true);
    setRefreshing(false);
    setError(null);
  }, [namespaceId]);

  useEffect(() => {
    if (refreshToken > 0) {
      void loadCatalog({ forceRefresh: true });
    }
  }, [refreshToken, loadCatalog]);

  useEffect(() => {
    const onRefresh = (): void => {
      void loadCatalog();
    };
    window.addEventListener("papr-community-catalog-refresh", onRefresh);
    return () => window.removeEventListener("papr-community-catalog-refresh", onRefresh);
  }, [loadCatalog]);

  const fetchLineage = useCallback(async () => {
    try {
      const res = await fetch(`${GATEWAY}/api/cloud/lineage`);
      if (!res.ok) return;
      const body = (await res.json()) as CloudLineageIndex;
      setLineageIndex(body);
    } catch {
      /* optional */
    }
  }, []);

  useEffect(() => {
    if (!catalog) return;
    void loadArtifacts();
    void fetchLineage();
  }, [catalog, loadArtifacts, fetchLineage]);

  const openAgentDatabaseSetup = useCallback(
    async (message: string, appId?: string, appTitle?: string) => {
      const chatId = await createChat();
      if (!chatId) return;

      const tabId = createTab("chat", chatId, "App setup");
      switchToTab(tabId);

      let fullMessage = message;
      if (appId) {
        fullMessage +=
          `\n\nWhen setup is complete, open the app tab (appId: ${appId}` +
          (appTitle ? `, title: "${appTitle}"` : "") +
          ").";
      }

      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("papr-onboarding-send", {
            detail: { message: fullMessage },
          }),
        );
      }, 300);
    },
    [createChat, createTab, switchToTab],
  );

  const startAgentImport = async (
    entry: OssRegistryEntry,
    wizard: WizardResult | null,
  ) => {
    const chatId = await createChat();
    if (!chatId) return;

    const tabId = createTab("chat", chatId, "New Chat");
    switchToTab(tabId);

    let message =
      `Import the community app "${entry.name}" (bundleId: ${entry.bundleId}). ` +
      `It's in the Papr-ai/paprwork-community-apps repo at path: ${entry.path}. ` +
      `Please handle the full setup — clone the community repo, import the bundle, ` +
      `set up any virtual environments, install dependencies, and verify everything works.`;

    if (wizard) {
      if (wizard.configured.length > 0) {
        const names = wizard.configured.map((k) => k.keyName);
        message += `\n\nThe following API keys are already configured in Settings: ${names.join(", ")}.`;
      }

      if (wizard.substituted.length > 0) {
        message += `\n\nIMPORTANT — Service substitutions requested:`;
        for (const sub of wizard.substituted) {
          message +=
            `\n- Replace ${sub.originalService} (${sub.originalKeyName}) with ` +
            `${sub.chosenService} (${sub.chosenKeyName}). The key for ${sub.chosenService} ` +
            `is already saved in Settings. Please rewrite the data pipeline job(s) to use ` +
            `\${${sub.chosenKeyName}} and the ${sub.chosenService} API instead of ${sub.originalService}.`;
        }
      }

      if (wizard.skipped.length > 0) {
        const skipped = wizard.skipped.map((k) => `${k.service} (${k.keyName})`);
        message += `\n\nNote: These keys were skipped and are not configured: ${skipped.join(", ")}. The app features that depend on them may not work until the user adds them in Settings.`;
      }
    } else {
      const reqs = entry.requirements ?? [];
      if (reqs.length > 0) {
        const normalized = normalizeRequirements(reqs);
        const names = normalized.map((r) => r.name);
        message += ` This app requires: ${names.join(", ")}.`;
      }
    }

    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("papr-onboarding-send", { detail: { message } }),
      );
    }, 300);
  };

  useEffect(() => {
    if (!installToast) return;
    const timer = setTimeout(() => setInstallToast(null), 4000);
    return () => clearTimeout(timer);
  }, [installToast]);

  const installCloudApp = async (
    entry: CommunityCatalogEntry,
    mode: CloudInstallMode = "fork",
  ) => {
    if (!entry.namespaceId || !entry.slug) {
      setError("This cloud app is missing namespace or slug metadata");
      return;
    }

    setInstallingId(entry.catalogId);
    setInstallError(null);
    try {
      const res = await fetch(`${GATEWAY}/api/cloud/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          namespaceId: entry.namespaceId,
          slug: entry.slug,
          mode,
        }),
      });
      const body = (await res.json()) as {
        app?: { id: string; title?: string };
        requirements?: RequiredKeySpec[];
        bootstrap?: {
          ready?: boolean;
          needsSeed?: boolean;
          warnings?: string[];
        };
        agentSetupMessage?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `Install failed (${res.status})`);
      }

      const title = body.app?.title ?? entry.name;
      const modeLabel = mode === "track" ? "Linked" : "Forked";
      trackEvent("paprwork_community_app_installed", { app_name: entry.name, app_id: entry.appId } as Record<string, unknown>);

      const needsFollowUp =
        Boolean(body.agentSetupMessage) ||
        body.bootstrap?.needsSeed === true ||
        (body.bootstrap?.warnings?.length ?? 0) > 0;

      if (needsFollowUp && body.agentSetupMessage) {
        setInstallToast(
          `${modeLabel} "${title}" — finishing database setup in chat…`,
        );
        void openAgentDatabaseSetup(
          body.agentSetupMessage,
          body.app?.id,
          title,
        );
      } else {
        setInstallToast(`${modeLabel} "${title}" into Paprwork`);
      }

      void loadArtifacts();
      void fetchLineage();
      if (body.app?.id) {
        const userReqs = userProvidedRequirements(
          body.requirements ?? entry.requirements,
        );
        if (userReqs.length > 0) {
          setCloudInstallWizard({
            appId: body.app.id,
            appTitle: title,
            requirements: userReqs,
          });
          return;
        }
        if (!needsFollowUp) {
          const tabId = createTab("app", body.app.id, title);
          switchToTab(tabId);
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message.slice(0, 240) : "Install failed";
      setInstallError(message);
      void openAgentDatabaseSetup(
        `Community app install for "${entry.name}" failed.\n\nError: ${message}\n\nPlease diagnose linked jobs, data-sources.json, databases.json, and migration files; fix paths; apply migrations; run Turso pull if cloud sync is on; then verify writes work.`,
      );
    } finally {
      setInstallingId(null);
    }
  };

  const startCloudInstall = (entry: CommunityCatalogEntry) => {
    if (entry.codeInstallable) {
      setInstallModeEntry(entry);
      return;
    }
    void installCloudApp(entry);
  };

  const openLocalApp = useCallback(
    (appId: string, title: string) => {
      const tabId = createTab("app", appId, title);
      switchToTab(tabId);
    },
    [createTab, switchToTab],
  );

  const openCloudPreview = useCallback(
    (entry: CommunityCatalogEntry) => {
      const previewIframeUrl = resolveCatalogPreviewIframeUrl(entry);
      const liveUrl = resolveCatalogLiveWebUrl(entry);
      if (!previewIframeUrl || !liveUrl) {
        setInstallError("This app does not have a live preview URL yet.");
        return;
      }

      trackEvent("paprwork_community_app_previewed", {
        url: liveUrl,
        app_name: entry.name,
        in_app_iframe: true,
      } as Record<string, unknown>);

      const metadata: CloudCatalogPreviewTabMetadata = {
        cloudCatalogPreview: true,
        previewIframeUrl,
        liveUrl,
        catalogId: entry.catalogId,
        ...(entry.appId ? { publisherAppId: entry.appId } : {}),
        ...(entry.namespaceId ? { namespaceId: entry.namespaceId } : {}),
        ...(entry.slug ? { slug: entry.slug } : {}),
      };

      const entityId = cloudCatalogPreviewEntityId(entry.catalogId);
      const tabId = createTab("app", entityId, entry.name, metadata);
      switchToTab(tabId);
    },
    [createTab, switchToTab],
  );

  const prefetchCloudPreview = useCallback((
    entry: CommunityCatalogEntry,
    localAppId: string | null,
  ) => {
    if (localAppId) {
      return;
    }
    const liveUrl = resolveCatalogLiveWebUrl(entry);
    const namespaceId = entry.namespaceId?.trim();
    const slug = entry.slug?.trim();
    if (!liveUrl || !namespaceId || !slug) {
      return;
    }
    let shareToken: string | undefined;
    try {
      shareToken = new URL(liveUrl).searchParams.get("t") ?? undefined;
    } catch {
      shareToken = undefined;
    }
    prefetchCloudPreviewSession({
      namespaceId,
      slug,
      shareToken,
      liveUrl,
    });
  }, []);

  const handleOssImportClick = (entry: CommunityCatalogEntry) => {
    const ossEntry = toOssEntry(entry);
    const reqs = entry.requirements ?? [];
    if (reqs.length > 0) {
      setWizardEntry(ossEntry);
    } else {
      void startAgentImport(ossEntry, null);
    }
  };

  const handleWizardComplete = (result: WizardResult) => {
    if (!wizardEntry) return;
    setWizardEntry(null);
    void startAgentImport(wizardEntry, result);
  };

  const handleWizardHelp = async (request: HelpRequest) => {
    const chatId = await createChat();
    if (!chatId) return;

    const tabId = createTab("chat", chatId, `Help: ${request.service}`);
    switchToTab(tabId);

    let message =
      `I need help getting an API key for ${request.service} (key name: ${request.keyName}).`;

    if (request.instructions) {
      message += ` The instructions say: "${request.instructions}"`;
    }
    if (request.signupUrl) {
      message += ` The signup page is: ${request.signupUrl}`;
    }
    if (request.docsUrl) {
      message += ` Docs: ${request.docsUrl}`;
    }

    message +=
      ` Please walk me through the process step by step. ` +
      `Once I have the key, I'll paste it in the setup wizard and come back here.`;

    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("papr-onboarding-send", { detail: { message } }),
      );
    }, 300);
  };

  const filteredEntries =
    catalog?.entries.filter((entry) => {
      if (scope === "global" && !entry.codeInstallable && !entry.liveViewable) {
        return false;
      }
      if (scope === "global" && !shouldShowInCommunityBrowse(entry)) {
        return false;
      }
      if (scope !== "global" && entry.source === "opensource") {
        return false;
      }
      if (entry.source === "opensource" && !showAllPlatforms) {
        const platforms = entry.platform ?? ["macos", "windows", "linux"];
        if (!platforms.includes(userPlatform)) return false;
      }
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        entry.name.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q) ||
        entry.tags.some((t) => t.toLowerCase().includes(q)) ||
        entry.author.toLowerCase().includes(q)
      );
    }) ?? [];

  const teamEntries =
    scope === "namespace"
      ? filteredEntries.filter((entry) => isTeamSharedVisibility(entry.visibility))
      : [];
  const publicWorkspaceEntries =
    scope === "namespace"
      ? filteredEntries.filter((entry) => !isTeamSharedVisibility(entry.visibility))
      : sortCommunityEntriesInstallableFirst(filteredEntries);

  const renderCatalogGrid = (entries: CommunityCatalogEntry[]) => (
    <div className="community-apps__grid">
      {entries.map((entry) => {
        const localAppId = resolveLocalAppIdForCatalogEntry(
          entry,
          installedAppIds,
          lineageIndex,
        );
        return (
          <CommunityAppCard
            key={entry.catalogId}
            entry={entry}
            localAppId={localAppId}
            isInstalled={
              entry.source === "cloud"
                ? isCloudEntryInstalled(entry, installedAppIds, lineageIndex)
                : Boolean(entry.bundleId && installedAppIds.has(entry.bundleId))
            }
            installedForkCount={installedForkCountForEntry(entry, lineageIndex)}
            onOssImport={() => handleOssImportClick(entry)}
            onCloudInstall={() => startCloudInstall(entry)}
            isInstalling={installingId === entry.catalogId}
            onOpen={
              localAppId
                ? () => openLocalApp(localAppId, entry.name)
                : entry.liveUrl || (entry.namespaceId && entry.slug)
                  ? () => openCloudPreview(entry)
                  : undefined
            }
            onOpenHover={
              !localAppId && (entry.liveUrl || (entry.namespaceId && entry.slug))
                ? () => prefetchCloudPreview(entry, localAppId)
                : undefined
            }
          />
        );
      })}
    </div>
  );

  const hiddenByPlatform =
    scope === "global"
      ? showAllPlatforms
        ? 0
        : (catalog?.entries.filter((entry) => {
            if (entry.source !== "opensource") return false;
            const platforms = entry.platform ?? ["macos", "windows", "linux"];
            return !platforms.includes(userPlatform);
          }).length ?? 0)
      : 0;

  if (loading) {
    return (
      <div className="community-apps__status">
        <div className="community-apps__spinner" />
        <p>{catalogLoadingLabel}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="community-apps__status">
        <p className="community-apps__error">{error}</p>
        <button className="community-apps__retry-btn" onClick={() => void loadCatalog({ forceRefresh: true })}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="community-apps">
      {hideToolbar ? (
        !loading && !error ? (
          <div className="apps-view__library-toolbar">
            <span className="apps-view__section-label">
              {scope === "namespace" ? "Team apps" : "Community apps"}
            </span>
            <div className="apps-view__library-toolbar-actions">
              {catalog ? (() => {
                const summary = catalogSummaryLine(
                  scope,
                  catalog,
                  namespaceName,
                  refreshing,
                  " · some from global",
                );
                return summary ? (
                  <span className="apps-view__library-count">{summary}</span>
                ) : null;
              })() : null}
            </div>
          </div>
        ) : null
      ) : (
        <div className="community-apps__toolbar">
          <input
            type="text"
            className="community-apps__search"
            placeholder={
              scope === "namespace"
                ? "Search workspace apps..."
                : "Search community apps..."
            }
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button className="community-apps__refresh-btn" onClick={() => void loadCatalog({ forceRefresh: true })}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M1 4v6h6M23 20v-6h-6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      )}

      {!hideToolbar && catalog ? (() => {
        const summary = catalogSummaryLine(
          scope,
          catalog,
          namespaceName,
          refreshing,
          " · some results from global catalog",
        );
        return summary ? (
          <p className="community-apps__summary">{summary}</p>
        ) : null;
      })() : null}

      {installToast ? (
        <p className="community-apps__summary">{installToast}</p>
      ) : null}

      {installError ? (
        <div className="community-apps__install-error" role="alert">
          <p className="community-apps__install-error-text">{installError}</p>
          <button
            type="button"
            className="community-apps__install-error-dismiss"
            onClick={() => setInstallError(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {hiddenByPlatform > 0 && (
        <button
          className="community-apps__platform-toggle"
          onClick={() => setShowAllPlatforms(!showAllPlatforms)}
        >
          {showAllPlatforms
            ? "Show compatible only"
            : `Show all platforms (+${hiddenByPlatform} hidden)`}
        </button>
      )}

      {filteredEntries.length === 0 && (
        <div className="community-apps__status">
          <p className="community-apps__empty-text">
            {emptyMessage(scope, searchQuery, namespaceName)}
          </p>
        </div>
      )}

      {scope === "namespace" ? (
        <>
          {teamEntries.length > 0 ? (
            <section className="community-apps__section">
              <h3 className="community-apps__section-title">Shared with team</h3>
              {renderCatalogGrid(teamEntries)}
            </section>
          ) : null}
          {publicWorkspaceEntries.length > 0 ? (
            <section className="community-apps__section">
              <h3 className="community-apps__section-title">Public in workspace</h3>
              {renderCatalogGrid(publicWorkspaceEntries)}
            </section>
          ) : null}
        </>
      ) : (
        renderCatalogGrid(publicWorkspaceEntries)
      )}

      {installModeEntry ? (
        <CloudCatalogInstallModal
          entry={installModeEntry}
          installing={installingId === installModeEntry.catalogId}
          onClose={() => setInstallModeEntry(null)}
          onSelectMode={(mode) => {
            const target = installModeEntry;
            setInstallModeEntry(null);
            void installCloudApp(target, mode);
          }}
        />
      ) : null}

      {wizardEntry && (
        <ImportSetupWizard
          appName={wizardEntry.name}
          appDescription={wizardEntry.description}
          appIcon={wizardEntry.icon}
          requirements={wizardEntry.requirements ?? []}
          onComplete={handleWizardComplete}
          onCancel={() => setWizardEntry(null)}
          onRequestHelp={(req) => void handleWizardHelp(req)}
        />
      )}

      {cloudInstallWizard ? (
        <ImportSetupWizard
          appName={cloudInstallWizard.appTitle}
          requirements={cloudInstallWizard.requirements}
          onComplete={() => {
            const { appId, appTitle } = cloudInstallWizard;
            setCloudInstallWizard(null);
            const tabId = createTab("app", appId, appTitle);
            switchToTab(tabId);
          }}
          onCancel={() => {
            const { appId, appTitle } = cloudInstallWizard;
            setCloudInstallWizard(null);
            const tabId = createTab("app", appId, appTitle);
            switchToTab(tabId);
          }}
          onRequestHelp={(req) => void handleWizardHelp(req)}
        />
      ) : null}
    </div>
  );
}

interface CommunityAppCardProps {
  entry: CommunityCatalogEntry;
  localAppId?: string | null;
  isInstalled: boolean;
  installedForkCount?: number;
  isInstalling?: boolean;
  onOssImport: () => void;
  onCloudInstall: () => void;
  onOpen?: () => void;
  onOpenHover?: () => void;
}

function CommunityAppCard({
  entry,
  localAppId = null,
  isInstalled,
  installedForkCount = 0,
  isInstalling = false,
  onOssImport,
  onCloudInstall,
  onOpen,
  onOpenHover,
}: CommunityAppCardProps) {
  const [showDetails, setShowDetails] = useState(false);

  const rawReqs = entry.requirements ?? [];
  const requirements = normalizeRequirements(rawReqs);
  const hasNoRequirements = requirements.length === 0;

  const allPlatforms = ["macos", "windows", "linux"];
  const platforms = entry.platform ?? allPlatforms;
  const requiresDesktop = entry.requiresDesktopForFullFunctionality ?? false;
  const isCrossPlatform =
    platforms.length === allPlatforms.length &&
    allPlatforms.every((p) => platforms.includes(p)) &&
    !requiresDesktop;

  const platformLabel = isCrossPlatform
    ? "All Platforms"
    : requiresDesktop &&
        platforms.length === allPlatforms.length &&
        allPlatforms.every((p) => platforms.includes(p))
      ? "Desktop required"
      : platforms
          .map((p) =>
            p === "macos" ? "macOS" : p === "windows" ? "Windows" : "Linux",
          )
          .join(", ");

  const showPlatformBadge =
    entry.source === "opensource"
      ? !isCrossPlatform
      : requiresDesktop || !isCrossPlatform;

  const renderIcon = () => {
    if (entry.icon?.trim()) {
      const trimmed = entry.icon.trim();

      if (trimmed.startsWith("data:image/") || trimmed.startsWith("http")) {
        return (
          <img
            className="community-card__orb-icon community-card__orb-icon--image"
            src={trimmed}
            alt={entry.name}
            draggable={false}
          />
        );
      }

      if (trimmed.startsWith("<")) {
        return (
          <span
            className="community-card__orb-icon"
            dangerouslySetInnerHTML={{ __html: sanitizeIcon(trimmed) }}
          />
        );
      }

      const isEmoji =
        trimmed.length <= 4 && /[\p{Emoji}]/u.test(trimmed);
      if (isEmoji) {
        return (
          <span className="community-card__orb-icon">{trimmed}</span>
        );
      }
    }

    return (
      <svg
        className="community-card__orb-icon"
        width="44"
        height="44"
        viewBox="0 0 24 24"
        fill="none"
      >
        <defs>
          <linearGradient id="community-papr-blue-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#00D4FF" />
            <stop offset="100%" stopColor="#0066FF" />
          </linearGradient>
        </defs>
        <rect x="3" y="3" width="7" height="7" rx="2" stroke="url(#community-papr-blue-gradient)" strokeWidth="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="2" stroke="url(#community-papr-blue-gradient)" strokeWidth="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="2" stroke="url(#community-papr-blue-gradient)" strokeWidth="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="2" stroke="url(#community-papr-blue-gradient)" strokeWidth="1.5" />
      </svg>
    );
  };

  const showInstall = canInstallCloudCatalogEntry(entry, localAppId);
  const shareBadge = getCatalogShareBadge(entry);
  const byline = getCatalogByline(entry);
  const displayTags = filterCatalogDisplayTags(entry.tags);

  return (
    <div className="community-card">
      <div className="community-card__preview">
        <div className="community-card__orb">
          <div className="community-card__orb-inner">{renderIcon()}</div>
        </div>
      </div>

      <div className="community-card__content">
        <div className="community-card__title-row">
          <h3 className="community-card__title">{entry.name}</h3>
          {entry.isOwned ? (
            <span className="community-card__badge community-card__badge--owned">
              Yours
            </span>
          ) : null}
          {installedForkCount > 0 ? (
            <span className="community-card__badge community-card__badge--fork">
              {installedForkCount} fork{installedForkCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {shareBadge ? (
            <span
              className={`community-card__badge community-card__badge--share${
                entry.source === "opensource"
                  ? " community-card__badge--share-oss"
                  : isTeamSharedVisibility(entry.visibility)
                    ? " community-card__badge--share-team"
                    : " community-card__badge--share-public"
              }`}
            >
              {shareBadge}
            </span>
          ) : null}
        </div>
        <p className="community-card__description">{entry.description}</p>
        <div className="community-card__meta">
          <span className="community-card__byline">{byline}</span>
          <button
            className="community-card__details-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setShowDetails(!showDetails);
            }}
          >
            {showDetails ? "Less" : "Details"}
          </button>
        </div>
        {displayTags.length > 0 || showPlatformBadge ? (
          <div className="community-card__tags">
            {displayTags.map((tag) => (
              <span key={tag} className="community-card__tag">
                {tag}
              </span>
            ))}
            {showPlatformBadge ? (
              <span className="community-card__platform-badge">{platformLabel}</span>
            ) : null}
          </div>
        ) : null}

        {showDetails && (
          <div className="community-card__details">
            <div className="community-card__detail-row">
              <span className="community-card__detail-label">Requirements</span>
              <span
                className={`community-card__detail-value ${hasNoRequirements ? "community-card__detail-value--good" : "community-card__detail-value--warn"}`}
              >
                {requirements.length > 0
                  ? requirements
                      .map((r) => lookupService(r.name)?.service ?? r.name)
                      .join(", ")
                  : "No API keys needed"}
              </span>
            </div>
            {showPlatformBadge ? (
              <div className="community-card__detail-row">
                <span className="community-card__detail-label">Platform</span>
                <span
                  className={`community-card__detail-value ${isCrossPlatform ? "community-card__detail-value--good" : ""}`}
                >
                  {platformLabel}
                  {entry.source === "cloud" && requiresDesktop
                    ? " for full functionality"
                    : ""}
                </span>
              </div>
            ) : null}
            <div className="community-card__detail-row">
              <span className="community-card__detail-label">Open</span>
              <span className="community-card__detail-value">
                {entry.source === "cloud"
                  ? localAppId
                    ? "Open in My Apps"
                    : entry.liveViewable
                      ? "Live preview in Paprwork"
                      : entry.codeInstallable
                        ? "Customize locally (fork)"
                        : "Web app only"
                  : "GitHub bundle"}
              </span>
            </div>
            {entry.source === "cloud" && entry.codeInstallable ? (
              <div className="community-card__detail-row">
                <span className="community-card__detail-label">Customize</span>
                <span className="community-card__detail-value">
                  Fork source to edit or contribute (optional)
                </span>
              </div>
            ) : null}
            {entry.source === "cloud" && entry.slug ? (
              <div className="community-card__detail-row">
                <span className="community-card__detail-label">Slug</span>
                <span className="community-card__detail-value">{entry.slug}</span>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {entry.source === "cloud" ? (
        <div className="community-card__actions">
          <div className="community-card__actions-row">
            {onOpen ? (
              <button
                type="button"
                className="community-card__action-btn community-card__action-btn--primary"
                onClick={onOpen}
                onMouseEnter={onOpenHover}
                onFocus={onOpenHover}
              >
                Open
              </button>
            ) : null}
            {showInstall ? (
              <button
                type="button"
                className={`community-card__action-btn${onOpen ? "" : " community-card__action-btn--primary"}`}
                onClick={onCloudInstall}
                disabled={isInstalling}
              >
                {isInstalling ? "Installing…" : "Customize"}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <button
          className={`community-card__import-btn ${isInstalled ? "community-card__import-btn--disabled community-card__import-btn--success" : ""}`}
          onClick={onOssImport}
          disabled={isInstalled}
        >
          {isInstalled ? "Installed" : "Import"}
        </button>
      )}
    </div>
  );
}
