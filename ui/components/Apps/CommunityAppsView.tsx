/**
 * CommunityAppsView - Browse Papr Cloud + open-source community apps
 */

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import { gateway } from "../../src/lib/gateway";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useChat } from "../../hooks/useChat";
import { useTabs } from "../../hooks/useTabs";
import type { WizardResult } from "./ImportSetupWizard";
import type { CommunityCatalogEntry, CommunityCatalogScope } from "../../../src/core/types/communityCatalog";
import { isTeamSharedVisibility } from "../../../src/core/types/communityCatalog";
import { resolveOneInstallSelection } from "../../../src/core/utils/cloudCatalogInstallPolicy";
import type { RequirementItem } from "../../../src/core/types/bundles";
import { useAppCategories } from "../../hooks/useAppCategories";
import { CategoryPills, matchesCategory } from "./CategoryPills";
import "./CommunityAppsView.css";
import "./AppsHome.css";
import { DropGlyph } from "./HomeTiles";
import { CatalogAppDetails, CatalogBanner, CatIcon, catalogBy, catalogKeyServices } from "./CatalogAppDetails";
import { FeaturedBanner, pickFeaturedCatalogEntry } from "./CatalogFeatured";
import { HomeMenu, type HomeMenuItem } from "./HomeMenu";
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
  getCatalogShareBadge,
} from "../../utils/communityCatalogDisplay";
import {
  shouldShowInCommunityBrowse,
  sortCommunityEntriesInstallableFirst,
} from "../../utils/communityCatalogBrowseFilter";
import {
  resolveCatalogLiveWebUrl,
  resolveCatalogPreviewIframeUrl,
  catalogCoverUrl,
} from "../../utils/catalogPreviewUrl";
import { prefetchCloudPreviewSession } from "../../utils/cloudPreviewSession";
import {
  cloudCatalogPreviewEntityId,
  type CloudCatalogPreviewTabMetadata,
} from "../../types/cloudCatalogPreviewTab";
import { ShareAudienceIcon } from "./WebSyncPopover";
import { shareGlyphForCatalogEntry } from "../../utils/shareGlyph";
import { shareAudienceShortLabel } from "../../utils/shareAudienceGlyphs";
import { CloudInstallOptionalDepsNotice } from "./CloudInstallOptionalDepsNotice";
import {
  CLOUD_INSTALL_TIMEOUT_MESSAGE,
  buildPostInstallAgentMessage,
  enrichInstallAgentMessageWithRequirements,
  extractOptionalInstallDependencies,
  installCloudCatalogApp,
  planCloudInstallFailureHandoff,
  type CloudCatalogInstallSelection,
} from "../../utils/cloudCatalogInstall";
import { openCloudInstalledAppWithChat } from "../../utils/openCloudInstalledAppWithChat";
import type { CloudAppDependenciesFile } from "../../../src/core/types/cloudAppDependencies";

const GATEWAY =
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";


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
  /** Right-aligned action in the section toolbar (e.g. open Skills) */
  toolbarTrailing?: ReactNode;
  /** Increment to refetch catalog from parent refresh button */
  refreshToken?: number;
  /** Shown while the catalog is loading (defaults from scope). */
  loadingLabel?: string;
  /**
   * Unified search: render only a "heading + matches" block (no toolbar,
   * summary or empty state) so several sources stack on one results page.
   * Renders nothing when there are no matches.
   */
  resultsHeading?: string;
  /**
   * My apps ⋯ actions for an app you have locally (favorite, archive, delete…).
   * Lets Team / Community cards share the same menu as library cards.
   */
  libraryMenuFor?: (appId: string) => HomeMenuItem[];
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
  toolbarTrailing,
  refreshToken = 0,
  loadingLabel,
  resultsHeading,
  libraryMenuFor,
}: CommunityAppsViewProps) {
  const [catalog, setCatalog] = useState<CommunityCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [internalSearchQuery, setInternalSearchQuery] = useState("");
  const searchQuery = searchQueryProp ?? internalSearchQuery;
  const setSearchQuery = onSearchQueryChange ?? setInternalSearchQuery;
  const [showAllPlatforms, setShowAllPlatforms] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const { snapshot: cats, categorize: categorizeEntries } = useAppCategories();
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installToast, setInstallToast] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [lineageIndex, setLineageIndex] = useState<CloudLineageIndex | null>(null);
  const [optionalDepsNotice, setOptionalDepsNotice] = useState<{
    appId: string;
    appTitle: string;
    dependencies: CloudAppDependenciesFile;
  } | null>(null);
  const { artifacts, loadArtifacts } = useArtifacts();
  const { createChat } = useChat();
  const { createTab, switchToTab } = useTabs();
  const userPlatform = detectUserPlatform();
  const catalogLoadingLabel = loadingLabel ?? defaultLoadingLabel(scope);

  const installedAppIds = new Set(
    artifacts.filter((artifact) => artifact.type === "app").map((artifact) => artifact.id),
  );
  // Apps on this computer that were made here (not installed from the catalog).
  const ownLocalAppIds = new Set(
    artifacts
      .filter((artifact) => artifact.type === "app" && !artifact.cloudLineage)
      .map((artifact) => artifact.id),
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
      if (appId && appTitle) {
        await openCloudInstalledAppWithChat(createChat, {
          appId,
          appTitle,
          agentMessage: message,
          chatTabTitle: "App setup",
        });
        return;
      }

      const chatId = await createChat();
      if (!chatId) return;

      const tabId = createTab("chat", chatId, "App setup");
      switchToTab(tabId);

      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("papr-onboarding-send", {
            detail: { message },
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
    } else if (entry.requirements?.length) {
      message = enrichInstallAgentMessageWithRequirements(
        message,
        entry.requirements,
      );
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
    selection: CloudCatalogInstallSelection = {
      mode: "fork",
      installDbPolicy: "fork_empty",
    },
  ) => {
    const { mode } = selection;
    if (!entry.namespaceId || !entry.slug) {
      setError("This cloud app is missing namespace or slug metadata");
      return;
    }

    setInstallingId(entry.catalogId);
    setInstallError(null);
    try {
      const result = await installCloudCatalogApp(entry, selection, {
        catalogScope: scope,
      });
      if (!result.ok) {
        const plan = planCloudInstallFailureHandoff(entry, mode, result);
        if (plan.kind === "agent") {
          setInstallError(null);
          setInstallToast(plan.toast);
          void openAgentDatabaseSetup(plan.agentMessage);
          return;
        }
        throw new Error(plan.message);
      }
      const body = result.data;

      const title = body.app?.title ?? entry.name;
      const modeLabel = "Installed";
      trackEvent("paprwork_community_app_installed", { app_name: entry.name, app_id: entry.appId } as Record<string, unknown>);

      const optionalDeps = extractOptionalInstallDependencies(body);
      const hasOptionalDeps = optionalDeps !== null;

      const needsSeed = body.bootstrap?.needsSeed === true;
      const needsAgentSetup = Boolean(body.agentSetupMessage);

      if (needsAgentSetup) {
        setInstallToast(
          `${modeLabel} "${title}" — finishing database setup in chat…`,
        );
        void openAgentDatabaseSetup(
          buildPostInstallAgentMessage({
            appId: body.app?.id ?? "",
            appTitle: title,
            mode,
            needsSeed,
            catalogDescription: entry.description,
            requirements: body.requirements ?? entry.requirements,
            agentSetupMessage: body.agentSetupMessage,
          }),
          body.app?.id,
          title,
        );
      } else if (hasOptionalDeps && body.app?.id && optionalDeps) {
        setInstallToast(
          `${modeLabel} "${title}" — core features ready. Optional apps listed separately.`,
        );
        setOptionalDepsNotice({
          appId: body.app.id,
          appTitle: title,
          dependencies: optionalDeps,
        });
      } else if (needsSeed) {
        setInstallToast(
          `${modeLabel} "${title}" — schema ready. Run linked jobs to seed data when needed.`,
        );
      } else {
        setInstallToast(`${modeLabel} "${title}" into Paprwork`);
      }

      void loadArtifacts();
      void fetchLineage();
      if (body.app?.id && !needsAgentSetup) {
        await openCloudInstalledAppWithChat(createChat, {
          appId: body.app.id,
          appTitle: title,
          agentMessage: buildPostInstallAgentMessage({
            appId: body.app.id,
            appTitle: title,
            mode,
            needsSeed,
            catalogDescription: entry.description,
            requirements: body.requirements ?? entry.requirements,
          }),
        });
      }
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === "AbortError"
          ? CLOUD_INSTALL_TIMEOUT_MESSAGE
          : err instanceof Error
            ? err.message.slice(0, 240)
            : "Install failed";
      const plan = planCloudInstallFailureHandoff(entry, mode, {
        ok: false,
        error: message,
      });
      if (plan.kind === "agent") {
        setInstallError(null);
        setInstallToast(plan.toast);
        void openAgentDatabaseSetup(plan.agentMessage);
      } else {
        setInstallError(plan.message);
        setInstallToast(`Install failed for "${entry.name}": ${plan.message}`);
      }
    } finally {
      setInstallingId(null);
    }
  };

  const startCloudInstall = (entry: CommunityCatalogEntry) => {
    if (!entry.codeInstallable) {
      void installCloudApp(entry);
      return;
    }
    // v5: one Install (see resolveOneInstallSelection).
    void installCloudApp(
      entry,
      resolveOneInstallSelection({
        catalogScope: scope,
        visibility: entry.visibility,
        codeInstallable: entry.codeInstallable,
      }),
    );
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
      const tabId = createTab("app", entityId, entry.name, metadata as unknown as Record<string, unknown>);
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
    void startAgentImport(ossEntry, null);
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

  // Broad categories (Jev-sorted) for the filter pills. Keys are per catalog id.
  const catKey = (entry: CommunityCatalogEntry) => `catalog:${entry.catalogId}`;
  // The publisher's category (sent at publish) wins; older publishes without
  // one are sorted locally until they're republished.
  const entryCats = useMemo(() => {
    const m: Record<string, string | null> = { ...cats.byKey };
    const live = new Set(cats.categories.map((c) => c.name));
    for (const e of filteredEntries) {
      if (e.category && (live.has(e.category) || scope === "namespace")) m[catKey(e)] = e.category;
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cats, filteredEntries, scope]);
  const unsorted = filteredEntries.filter((e) => !e.category);
  const categorizeSig = unsorted.map((e) => e.catalogId).join("|");
  useEffect(() => {
    if (!unsorted.length || resultsHeading) return;
    categorizeEntries(
      unsorted.map((e) => ({
        key: catKey(e),
        title: e.name,
        description: e.description,
        tags: e.tags,
      })),
      scope === "namespace" ? "team" : "community",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categorizeSig, scope, resultsHeading]);
  useEffect(() => setCategory(null), [scope]);
  const categoryEntries =
    category === null || resultsHeading
      ? filteredEntries
      : filteredEntries.filter((e) => matchesCategory(catKey(e), entryCats, category));

  const teamEntries =
    scope === "namespace"
      ? categoryEntries.filter((entry) => isTeamSharedVisibility(entry.visibility))
      : [];
  const publicWorkspaceEntries =
    scope === "namespace"
      ? categoryEntries.filter((entry) => !isTeamSharedVisibility(entry.visibility))
      : sortCommunityEntriesInstallableFirst(categoryEntries);

  const renderCatalogCard = (entry: CommunityCatalogEntry, variant?: "featured") => {
    const mine =
      entry.isOwned === true || Boolean(entry.appId && ownLocalAppIds.has(entry.appId));
    const resolved = resolveLocalAppIdForCatalogEntry(
      mine ? { ...entry, isOwned: true } : entry,
      installedAppIds,
      lineageIndex,
    );
    // Publisher copy can only be opened if it's actually on this computer.
    const localAppId =
      resolved && (installedAppIds.has(resolved) || entry.isOwned === true) ? resolved : null;
    const cardEntry = mine ? { ...entry, isOwned: true } : entry;
    const liveUrl = entry.source === "cloud" ? resolveCatalogLiveWebUrl(entry) : null;
    const canGet = entry.source === "cloud" && canInstallCloudCatalogEntry(cardEntry, localAppId);
    const menuItems: HomeMenuItem[] = [];
    if (localAppId) {
      menuItems.push({ label: "Open", onSelect: () => openLocalApp(localAppId, entry.name) });
    }
    if (liveUrl) {
      menuItems.push({ label: "Open on the web", onSelect: () => openCloudPreview(entry) });
      menuItems.push({
        label: "Copy link",
        onSelect: () => void navigator.clipboard?.writeText(liveUrl).catch(() => undefined),
      });
    }
    if (canGet) menuItems.push({ label: "Get a copy", onSelect: () => startCloudInstall(entry) });
    const libraryItems = localAppId && libraryMenuFor ? libraryMenuFor(localAppId) : [];
    if (libraryItems.length) menuItems.push({ label: "—", onSelect: () => undefined }, ...libraryItems);
    return (
      <CommunityAppCard
        variant={variant}
        menu={
          menuItems.length ? (
            <HomeMenu items={menuItems} moveTargets={[]} onMove={() => undefined} />
          ) : null
        }
        key={entry.catalogId}
        entry={cardEntry}
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
        onOpenWeb={
          entry.source === "cloud" && (entry.liveUrl || (entry.namespaceId && entry.slug))
            ? () => openCloudPreview(entry)
            : undefined
        }
        onOpenWebHover={
          entry.source === "cloud" && (entry.liveUrl || (entry.namespaceId && entry.slug))
            ? () => prefetchCloudPreview(entry, null)
            : undefined
        }
        onOpenHover={
          !localAppId && (entry.liveUrl || (entry.namespaceId && entry.slug))
            ? () => prefetchCloudPreview(entry, localAppId)
            : undefined
        }
      />
    );
  };

  const renderCatalogGrid = (entries: CommunityCatalogEntry[]) => (
    <div className="community-apps__grid">{entries.map((entry) => renderCatalogCard(entry))}</div>
  );

  // Community "Featured": a publisher headline wins, then the most-installed app.
  const featured =
    scope === "global" && !resultsHeading && !searchQuery && category === null
      ? pickFeaturedCatalogEntry(publicWorkspaceEntries)
      : null;
  const gridEntries =
    scope === "namespace"
      ? [...teamEntries, ...publicWorkspaceEntries]
      : publicWorkspaceEntries.filter((e) => e !== featured);

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

  if (resultsHeading && (loading || error)) {
    return loading ? (
      <p className="apps-view__results-pending">
        {resultsHeading} <span>· searching…</span>
      </p>
    ) : null;
  }

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

  const searchMatches =
    scope === "namespace"
      ? [...teamEntries, ...publicWorkspaceEntries]
      : publicWorkspaceEntries;

  return (
    <div className="community-apps">
      {resultsHeading ? (
        searchMatches.length > 0 ? (
          <section className="apps-view__results">
            <h2 className="apps-view__results-title">
              {resultsHeading} <em>{searchMatches.length}</em>
            </h2>
            {renderCatalogGrid(searchMatches)}
          </section>
        ) : null
      ) : hideToolbar ? (
        !loading && !error ? (
          <div className="apps-view__library-toolbar">
            <div className="apps-view__library-toolbar-leading">
              <span className="apps-view__section-label">
                {scope === "namespace" ? "Team apps" : "Community apps"}
              </span>
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
            <div className="apps-view__library-toolbar-actions">
              {toolbarTrailing}
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

      {!resultsHeading && !hideToolbar && catalog ? (() => {
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

      {!resultsHeading && hiddenByPlatform > 0 && (
        <button
          className="community-apps__platform-toggle"
          onClick={() => setShowAllPlatforms(!showAllPlatforms)}
        >
          {showAllPlatforms
            ? "Show compatible only"
            : `Show all platforms (+${hiddenByPlatform} hidden)`}
        </button>
      )}

      {!resultsHeading && filteredEntries.length === 0 && (
        <div className="community-apps__status">
          <p className="community-apps__empty-text">
            {emptyMessage(scope, searchQuery, namespaceName)}
          </p>
        </div>
      )}

      {resultsHeading ? null : (
        <CategoryPills
          keys={filteredEntries.map(catKey)}
          byKey={entryCats}
          order={[
            ...cats.categories.map((c) => c.name),
            ...[...new Set(Object.values(entryCats))].filter(
              (c): c is string => !!c && !cats.categories.some((x) => x.name === c),
            ),
          ]}
          value={category}
          onChange={setCategory}
        />
      )}

      {featured ? renderCatalogCard(featured, "featured") : null}

      {resultsHeading ? null : renderCatalogGrid(gridEntries)}

      {optionalDepsNotice ? (
        <CloudInstallOptionalDepsNotice
          appTitle={optionalDepsNotice.appTitle}
          dependencies={optionalDepsNotice.dependencies}
          onClose={() => setOptionalDepsNotice(null)}
          onOpenCommunityApps={() => {
            setOptionalDepsNotice(null);
            window.dispatchEvent(new CustomEvent("papr-open-community-apps"));
          }}
          onContinue={() => {
            const { appId, appTitle } = optionalDepsNotice;
            setOptionalDepsNotice(null);
            void openCloudInstalledAppWithChat(createChat, {
              appId,
              appTitle,
              agentMessage: buildPostInstallAgentMessage({
                appId,
                appTitle,
                mode: "fork",
              }),
            });
          }}
        />
      ) : null}
    </div>
  );
}

function CommunityInstallButtonLabel({
  installing,
  idleLabel,
}: {
  installing: boolean;
  idleLabel: string;
}): ReactElement {
  if (installing) {
    return (
      <>
        <span className="community-card__import-spinner" aria-hidden="true" />
        Installing…
      </>
    );
  }
  return <>{idleLabel}</>;
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
  /** The live web version (shown as "Open web" when you don't have a local copy). */
  onOpenWeb?: () => void;
  onOpenWebHover?: () => void;
  /** ⋯ menu (same component as My apps cards). */
  menu?: ReactNode;
  /** "featured" = the big Community banner. */
  variant?: "featured";
}

export function CommunityAppCard({
  entry,
  localAppId = null,
  isInstalled,
  installedForkCount = 0,
  isInstalling = false,
  onOssImport,
  onCloudInstall,
  onOpen,
  menu,
  onOpenWeb,
  onOpenWebHover,
  variant,
}: CommunityAppCardProps) {

  const showInstall = canInstallCloudCatalogEntry(entry, localAppId);
  // Open = your copy on this computer. Open web = the live web app. Get = install.
  const showLocalOpen = Boolean(localAppId) && Boolean(onOpen);
  const showOpenWeb = !showLocalOpen && Boolean(onOpenWeb);
  const share = shareGlyphForCatalogEntry(entry);
  const shareBadge = getCatalogShareBadge(entry);
  // Owner-approved cover (served by the cloud host); falls back to a gradient + droplet.
  const coverUrl = catalogCoverUrl(entry);
  const icon = entry.icon?.trim().startsWith("<") ? sanitizeIcon(entry.icon.trim()) : entry.icon;
  const shown = { ...entry, icon };
  const [details, setDetails] = useState(false);
  const keys = catalogKeyServices(entry);
  const hasWeb = Boolean(onOpenWeb) || Boolean(entry.liveUrl);

  const stop = (fn?: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn?.(); };
  const actions = (lg: boolean) => {
    const cls = (solid: boolean) => `cat-btn${lg ? " cat-btn--lg" : ""}${solid && lg ? " cat-btn--solid" : ""}`;
    if (entry.source !== "cloud") {
      return (
        <button type="button" className={cls(!isInstalled)} onClick={stop(onOssImport)} disabled={isInstalled}>
          {isInstalled ? "Installed" : "Get"}
        </button>
      );
    }
    return (
      <>
        {showLocalOpen ? (
          <button type="button" className={cls(true)} onClick={stop(onOpen)}
            title={installedForkCount > 1 ? `${installedForkCount} copies in your library` : "Open your copy"}>Open</button>
        ) : null}
        {showOpenWeb ? (
          <button type="button" className={cls(false)} onClick={stop(onOpenWeb)} title="Open the live web app"
            onMouseEnter={onOpenWebHover} onFocus={onOpenWebHover}>Open web</button>
        ) : null}
        {showInstall ? (
          <button type="button" className={cls(true)} onClick={stop(onCloudInstall)} disabled={isInstalling}
            aria-busy={isInstalling} title="Get this app">
            <CommunityInstallButtonLabel installing={isInstalling} idleLabel="Get" />
          </button>
        ) : null}
      </>
    );
  };

  const detailsModal = details ? (
    <CatalogAppDetails
      entry={shown}
      coverUrl={coverUrl}
      hasWeb={hasWeb && entry.source === "cloud"}
      actions={actions(true)}
      onClose={() => setDetails(false)}
    />
  ) : null;

  if (variant === "featured") {
    return (
      <FeaturedBanner entry={shown} coverUrl={coverUrl} onOpen={() => setDetails(true)} actions={actions(false)}>
        {detailsModal}
      </FeaturedBanner>
    );
  }

  // App Store–style: big banner, then droplet · name (+ small icons) · "By …" · buttons.
  // Details (schedule, keys, updated, description) live in the modal.
  return (
    <div
      className="cat-card"
      role="button"
      tabIndex={0}
      onClick={() => setDetails(true)}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) setDetails(true); }}
    >
      <CatalogBanner entry={shown} coverUrl={coverUrl} glyphSize={88} />
      <span className="cat-card__tr" onClick={(e) => e.stopPropagation()}>
        <span className="ah-share" title={shareBadge ?? shareAudienceShortLabel(share.audience)}>
          <ShareAudienceIcon audience={share.audience} loginAccess={null} codeAccess={share.codeAccess} />
        </span>
        {menu}
      </span>
      <div className="cat-row">
        <DropGlyph icon={icon} title={entry.name} size={44} />
        <div className="cat-row__txt">
          <h3 className="cat-row__t">
            <span className="cat-row__name" title={entry.name}>{entry.name}</span>
            <span className="cat-marks">
              {entry.isOwned ? <span className="is-mine" title="Yours"><CatIcon name="check" /></span> : null}
              {entry.catalogAutomation?.cardLine ? (
                <span title={`Automation · ${entry.catalogAutomation.cardLine}`}><CatIcon name="bolt" /></span>
              ) : null}
              {hasWeb && entry.source === "cloud" ? <span title="Works on the web"><CatIcon name="globe" /></span> : null}
              {keys.length ? <span title={`Needs ${keys.join(", ")} key${keys.length === 1 ? "" : "s"}`}><CatIcon name="key" /></span> : null}
            </span>
          </h3>
          <p className="cat-row__by">{catalogBy(entry)}</p>
        </div>
        <span className="cat-acts">{actions(false)}</span>
      </div>
      {detailsModal}
    </div>
  );
}
