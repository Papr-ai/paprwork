/**
 * Shared fork/track install flow for Team and Community cloud apps.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";
import type { RequiredKeySpec } from "../../src/core/types/bundles";
import type { HelpRequest } from "../components/Apps/ImportSetupWizard";
import { useArtifacts } from "./useArtifacts";
import { useChat } from "./useChat";
import { useTabs } from "./useTabs";
import { trackEvent } from "../lib/telemetry";
import {
  fetchCloudLineageIndex,
  installCloudCatalogApp,
  userProvidedRequirements,
  type CloudInstallMode,
} from "../utils/cloudCatalogInstall";
import {
  resolveLocalAppIdForCatalogEntry,
  type CloudLineageIndex,
} from "../utils/communityAppLocalOpen";

export function useCloudCatalogInstallFlow() {
  const [installModeEntry, setInstallModeEntry] =
    useState<CommunityCatalogEntry | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installToast, setInstallToast] = useState<string | null>(null);
  const [lineageIndex, setLineageIndex] = useState<CloudLineageIndex | null>(null);
  const [cloudInstallWizard, setCloudInstallWizard] = useState<{
    appId: string;
    appTitle: string;
    requirements: RequiredKeySpec[];
  } | null>(null);

  const { artifacts, loadArtifacts } = useArtifacts();
  const { createChat } = useChat();
  const { createTab, switchToTab } = useTabs();

  const installedAppIds = useMemo(
    () =>
      new Set(
        artifacts
          .filter((artifact) => artifact.type === "app")
          .map((artifact) => artifact.id),
      ),
    [artifacts],
  );

  const refreshLineage = useCallback(async () => {
    const index = await fetchCloudLineageIndex();
    if (index) {
      setLineageIndex(index);
    }
  }, []);

  useEffect(() => {
    void refreshLineage();
  }, [refreshLineage]);

  useEffect(() => {
    if (!installToast) return;
    const timer = window.setTimeout(() => setInstallToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [installToast]);

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

      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("papr-onboarding-send", {
            detail: { message: fullMessage },
          }),
        );
      }, 300);
    },
    [createChat, createTab, switchToTab],
  );

  const installCloudApp = useCallback(
    async (entry: CommunityCatalogEntry, mode: CloudInstallMode = "fork") => {
      setInstallingId(entry.catalogId);
      try {
        const result = await installCloudCatalogApp(entry, mode);
        if (!result.ok) {
          throw new Error(result.error);
        }

        const body = result.data;
        const title = body.app?.title ?? entry.name;
        const modeLabel = mode === "track" ? "Linked" : "Forked";
        trackEvent("paprwork_community_app_installed", {
          app_name: entry.name,
          app_id: entry.appId,
        } as Record<string, unknown>);

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
        void refreshLineage();

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
        void openAgentDatabaseSetup(
          `Community app install for "${entry.name}" failed.\n\nError: ${message}\n\nPlease diagnose linked jobs, data-sources.json, databases.json, and migration files; fix paths; apply migrations; run Turso pull if cloud sync is on; then verify writes work.`,
        );
      } finally {
        setInstallingId(null);
      }
    },
    [
      createTab,
      loadArtifacts,
      openAgentDatabaseSetup,
      refreshLineage,
      switchToTab,
    ],
  );

  const startCloudInstall = useCallback(
    (entry: CommunityCatalogEntry) => {
      if (entry.codeInstallable) {
        setInstallModeEntry(entry);
        return;
      }
      void installCloudApp(entry);
    },
    [installCloudApp],
  );

  const resolveLocalAppId = useCallback(
    (entry: CommunityCatalogEntry) =>
      resolveLocalAppIdForCatalogEntry(entry, installedAppIds, lineageIndex),
    [installedAppIds, lineageIndex],
  );

  const finishInstallWizard = useCallback(() => {
    if (!cloudInstallWizard) return;
    const { appId, appTitle } = cloudInstallWizard;
    setCloudInstallWizard(null);
    const tabId = createTab("app", appId, appTitle);
    switchToTab(tabId);
  }, [cloudInstallWizard, createTab, switchToTab]);

  const openInstallHelp = useCallback(
    async (request: HelpRequest) => {
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

      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("papr-onboarding-send", { detail: { message } }),
        );
      }, 300);
    },
    [createChat, createTab, switchToTab],
  );

  return {
    installModeEntry,
    setInstallModeEntry,
    installingId,
    installToast,
    cloudInstallWizard,
    setCloudInstallWizard,
    installCloudApp,
    startCloudInstall,
    resolveLocalAppId,
    finishInstallWizard,
    openInstallHelp,
    openAgentDatabaseSetup,
  };
}
