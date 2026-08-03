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
}: CommunityAppsViewProps) {
  const [catalog, setCatalog] = useState<CommunityCatalog | null>(null);
  const [loading, setLoading] = useState(true);
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

  const installedAppIds = new Set(
    artifacts.filter((artifact) => artifact.type === "app").map((artifact) => artifact.id),
  );

  const fetchCatalog = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
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
      setCatalog(response.data as CommunityCatalog);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load community apps",
      );
    } finally {
      setLoading(false);
    }
  }, [scope, namespaceId]);

  useEffect(() => {
    void fetchCatalog();
  }, [fetchCatalog]);

  useEffect(() => {
    if (refreshToken > 0) {
      void fetchCatalog();
    }
  }, [refreshToken, fetchCatalog]);

  useEffect(() => {
    const onRefresh = (): void => {
      void fetchCatalog();
    };
    window.addEventListener("papr-community-catalog-refresh", onRefresh);
    return () => window.removeEventListener("papr-community-catalog-refresh", onRefresh);
  }, [fetchCatalog]);

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
    void fetchLineage();
  }, [fetchLineage]);

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
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `Install failed (${res.status})`);
      }

      const title = body.app?.title ?? entry.name;
      const modeLabel = mode === "track" ? "Linked" : "Forked";
      trackEvent("paprwork_community_app_installed", { app_name: entry.name, app_id: entry.appId } as Record<string, unknown>);
      setInstallToast(`${modeLabel} "${title}" into Paprwork`);
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
        const tabId = createTab("app", body.app.id, title);
        switchToTab(tabId);
      }
    } catch (err) {
      setInstallError(
        err instanceof Error ? err.message.slice(0, 240) : "Install failed",
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

  const openLiveApp = async (url: string, appName?: string) => {
    trackEvent("paprwork_community_app_previewed", { url, app_name: appName } as Record<string, unknown>);
    try {
      if (window.electronAPI?.system?.invoke) {
        await window.electronAPI.system.invoke("shell.openExternal", url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch {
      /* ignore */
    }
  };

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
      : filteredEntries;

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
            onOpenLocal={
              localAppId
                ? () => openLocalApp(localAppId, entry.name)
                : undefined
            }
            onOpenLive={
              entry.liveViewable && entry.liveUrl
                ? () => void openLiveApp(entry.liveUrl!, entry.name)
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
        <p>Loading community apps...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="community-apps__status">
        <p className="community-apps__error">{error}</p>
        <button className="community-apps__retry-btn" onClick={() => void fetchCatalog(true)}>
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
              {catalog ? (
                <span className="apps-view__library-count">
                  {scope === "namespace"
                    ? namespaceSummary(catalog.entries, namespaceName)
                    : `${catalog.sources.cloud} cloud · ${catalog.sources.opensource} open source`}
                  {catalog.fallbackUsed && scope === "namespace"
                    ? " · some from global"
                    : null}
                </span>
              ) : null}
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
          <button className="community-apps__refresh-btn" onClick={() => void fetchCatalog(true)}>
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

      {!hideToolbar && catalog ? (
        <p className="community-apps__summary">
          {scope === "namespace"
            ? namespaceSummary(catalog.entries, namespaceName)
            : `${catalog.sources.cloud} cloud · ${catalog.sources.opensource} open source`}
          {catalog.fallbackUsed && scope === "namespace"
            ? " · some results from global catalog"
            : null}
        </p>
      ) : null}

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
        <div
          className="community-install-modal__backdrop"
          role="presentation"
          onClick={() => setInstallModeEntry(null)}
        >
          <div
            className="community-install-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="community-install-modal__title">
              Install {installModeEntry.name}
            </h3>
            <p className="community-install-modal__desc">
              Choose how this cloud app lands in your Paprwork workspace.
            </p>
            <button
              type="button"
              className="community-install-modal__option"
              disabled={installingId === installModeEntry.catalogId}
              onClick={() => {
                const target = installModeEntry;
                setInstallModeEntry(null);
                void installCloudApp(target, "fork");
              }}
            >
              <strong>Fork</strong>
              <span>Independent copy — edit freely, send changes back to owner.</span>
            </button>
            <button
              type="button"
              className="community-install-modal__option"
              disabled={installingId === installModeEntry.catalogId}
              onClick={() => {
                const target = installModeEntry;
                setInstallModeEntry(null);
                void installCloudApp(target, "track");
              }}
            >
              <strong>Track upstream</strong>
              <span>
                Stay linked to the publisher — get their updates manually when
                you want them (Local preview → Updates).
              </span>
            </button>
            <button
              type="button"
              className="community-install-modal__cancel"
              onClick={() => setInstallModeEntry(null)}
            >
              Cancel
            </button>
          </div>
        </div>
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
  onOpenLocal?: () => void;
  onOpenLive?: () => void;
}

function CommunityAppCard({
  entry,
  localAppId = null,
  isInstalled,
  installedForkCount = 0,
  isInstalling = false,
  onOssImport,
  onCloudInstall,
  onOpenLocal,
  onOpenLive,
}: CommunityAppCardProps) {
  const [showDetails, setShowDetails] = useState(false);

  const rawReqs = entry.requirements ?? [];
  const requirements = normalizeRequirements(rawReqs);
  const hasNoRequirements = requirements.length === 0;

  const allPlatforms = ["macos", "windows", "linux"];
  const platforms = entry.platform ?? allPlatforms;
  const isCrossPlatform =
    entry.source === "opensource" &&
    platforms.length === allPlatforms.length &&
    allPlatforms.every((p) => platforms.includes(p));

  const platformLabel = isCrossPlatform
    ? "All Platforms"
    : platforms
        .map((p) =>
          p === "macos" ? "macOS" : p === "windows" ? "Windows" : "Linux",
        )
        .join(", ");

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
        width="36"
        height="36"
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

  const sourceLabel =
    entry.source === "cloud"
      ? isTeamSharedVisibility(entry.visibility)
        ? "Team shared"
        : "Public"
      : "Open source";

  const showInstall = canInstallCloudCatalogEntry(entry, localAppId);

  return (
    <div className="community-card">
      <div className="community-card__orb">{renderIcon()}</div>

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
        </div>
        <p className="community-card__description">{entry.description}</p>
        <div className="community-card__meta">
          <span className="community-card__version">
            {entry.source === "cloud" ? "Live" : `v${entry.version}`}
          </span>
          <span className="community-card__author">by {entry.author}</span>
          <span
            className={
              entry.source === "cloud"
                ? "community-card__source-badge community-card__source-badge--cloud"
                : "community-card__source-badge community-card__source-badge--opensource"
            }
          >
            {sourceLabel}
          </span>
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
        <div className="community-card__tags">
          {entry.tags.map((tag) => (
            <span key={tag} className="community-card__tag">
              {tag}
            </span>
          ))}
          {entry.source === "opensource" && !isCrossPlatform && (
            <span className="community-card__platform-badge">{platformLabel}</span>
          )}
        </div>

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
            {entry.source === "opensource" ? (
              <div className="community-card__detail-row">
                <span className="community-card__detail-label">Platform</span>
                <span
                  className={`community-card__detail-value ${isCrossPlatform ? "community-card__detail-value--good" : ""}`}
                >
                  {platformLabel}
                </span>
              </div>
            ) : null}
            <div className="community-card__detail-row">
              <span className="community-card__detail-label">Install</span>
              <span className="community-card__detail-value">
                {entry.source === "cloud"
                  ? entry.codeInstallable
                    ? "Fork or track from Papr Cloud"
                    : "Live app only"
                  : "GitHub bundle"}
              </span>
            </div>
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
            {onOpenLocal ? (
              <button
                type="button"
                className="community-card__action-btn community-card__action-btn--primary"
                onClick={onOpenLocal}
              >
                Open in Paprwork
              </button>
            ) : null}
            {entry.liveViewable && onOpenLive ? (
              <button
                type="button"
                className="community-card__action-btn"
                onClick={onOpenLive}
              >
                Open live
              </button>
            ) : null}
            {showInstall ? (
              <button
                type="button"
                className="community-card__action-btn community-card__action-btn--primary"
                onClick={onCloudInstall}
                disabled={isInstalling}
              >
                {isInstalling ? "Installing…" : "Install"}
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
