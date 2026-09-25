/**
 * Shared fork/track install flow for Team and Community cloud apps.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CommunityCatalogEntry,
  CommunityCatalogScope,
} from "../../src/core/types/communityCatalog";
import { requiresInstallModeChoice } from "../../src/core/utils/cloudCatalogInstallPolicy";
import type { RequiredKeySpec } from "../../src/core/types/bundles";
import type { HelpRequest } from "../components/Apps/ImportSetupWizard";
import { useArtifacts } from "./useArtifacts";
import { useChat } from "./useChat";
import { useTabs } from "./useTabs";
import { trackEvent } from "../lib/telemetry";
import {
  buildCloudInstallBootstrapFailureAgentMessage,
  buildCloudInstallTimeoutAgentMessage,
  fetchCloudLineageIndex,
  extractOptionalInstallDependencies,
  installCloudCatalogApp,
  isCloudInstallBootstrapError,
  isCloudInstallTimeoutError,
  userProvidedRequirements,
  type CloudCatalogInstallSelection,
  type CloudInstallMode,
} from "../utils/cloudCatalogInstall";
import {
  buildCloudInstallWelcomeMessage,
  openCloudInstalledAppWithChat,
} from "../utils/openCloudInstalledAppWithChat";
import type { CloudAppDependenciesFile } from "../../src/core/types/cloudAppDependencies";
import {
  resolveLocalAppIdForCatalogEntry,
  type CloudLineageIndex,
} from "../utils/communityAppLocalOpen";

export function useCloudCatalogInstallFlow() {
  const [installModeEntry, setInstallModeEntry] = useState<{
    entry: CommunityCatalogEntry;
    catalogScope?: CommunityCatalogScope;
  } | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installToast, setInstallToast] = useState<string | null>(null);
  const [lineageIndex, setLineageIndex] = useState<CloudLineageIndex | null>(null);
  const [cloudInstallWizard, setCloudInstallWizard] = useState<{
    appId: string;
    appTitle: string;
    requirements: RequiredKeySpec[];
  } | null>(null);
  const [optionalDepsNotice, setOptionalDepsNotice] = useState<{
    appId: string;
    appTitle: string;
    dependencies: CloudAppDependenciesFile;
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

      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("papr-onboarding-send", {
            detail: { message },
          }),
        );
      }, 300);
    },
    [createChat, createTab, switchToTab],
  );

  const installCloudApp = useCallback(
    async (
      entry: CommunityCatalogEntry,
      selection: CloudCatalogInstallSelection = {
        mode: "fork",
        installDbPolicy: "fork_empty",
      },
      catalogScope?: CommunityCatalogScope,
    ) => {
      const { mode } = selection;
      setInstallingId(entry.catalogId);
      try {
        const result = await installCloudCatalogApp(entry, selection, {
          catalogScope,
        });
        if (!result.ok) {
          if (isCloudInstallTimeoutError(result.error)) {
            setInstallToast(
              `Install timed out for "${entry.name}" — opening chat for help…`,
            );
            void openAgentDatabaseSetup(
              buildCloudInstallTimeoutAgentMessage(entry, mode),
            );
            return;
          }
          throw new Error(result.error);
        }

        const body = result.data;
        const title = body.app?.title ?? entry.name;
        const modeLabel = mode === "track" ? "Linked" : "Forked";
        trackEvent("paprwork_community_app_installed", {
          app_name: entry.name,
          app_id: entry.appId,
        } as Record<string, unknown>);

        const optionalDeps = extractOptionalInstallDependencies(body);
        const hasOptionalDeps = optionalDeps !== null;

        const needsSeed = body.bootstrap?.needsSeed === true;
        const needsAgentSetup = Boolean(body.agentSetupMessage);

        if (needsAgentSetup) {
          setInstallToast(
            `${modeLabel} "${title}" — finishing database setup in chat…`,
          );
          void openAgentDatabaseSetup(
            body.agentSetupMessage!,
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
          if (needsAgentSetup) {
            return;
          }
          await openCloudInstalledAppWithChat(createChat, {
            appId: body.app.id,
            appTitle: title,
            agentMessage: buildCloudInstallWelcomeMessage({
              appId: body.app.id,
              appTitle: title,
              mode,
              needsSeed,
            }),
          });
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message.slice(0, 240) : "Install failed";
        if (isCloudInstallTimeoutError(message)) {
          setInstallToast(
            `Install timed out for "${entry.name}" — opening chat for help…`,
          );
          void openAgentDatabaseSetup(
            buildCloudInstallTimeoutAgentMessage(entry, mode),
          );
        } else if (isCloudInstallBootstrapError(message)) {
          setInstallToast(
            `Finishing database setup for "${entry.name}" in chat…`,
          );
          void openAgentDatabaseSetup(
            buildCloudInstallBootstrapFailureAgentMessage(entry, mode, message),
          );
        } else {
          setInstallToast(`Install failed for "${entry.name}": ${message}`);
        }
      } finally {
        setInstallingId(null);
      }
    },
    [createChat, loadArtifacts, openAgentDatabaseSetup, refreshLineage],
  );

  const startCloudInstall = useCallback(
    (
      entry: CommunityCatalogEntry,
      options?: { catalogScope?: CommunityCatalogScope },
    ) => {
      const catalogScope = options?.catalogScope ?? "global";
      if (!entry.codeInstallable) {
        void installCloudApp(
          entry,
          { mode: "fork", installDbPolicy: "fork_empty" },
          catalogScope,
        );
        return;
      }
      if (
        !requiresInstallModeChoice({
          catalogScope,
          visibility: entry.visibility,
          codeInstallable: entry.codeInstallable,
        })
      ) {
        void installCloudApp(
          entry,
          { mode: "fork", installDbPolicy: "fork_empty" },
          catalogScope,
        );
        return;
      }
      setInstallModeEntry({ entry, catalogScope });
    },
    [installCloudApp],
  );

  const resolveLocalAppId = useCallback(
    (entry: CommunityCatalogEntry) =>
      resolveLocalAppIdForCatalogEntry(entry, installedAppIds, lineageIndex),
    [installedAppIds, lineageIndex],
  );

  const finishInstallWizard = useCallback(async () => {
    if (!cloudInstallWizard) return;
    const { appId, appTitle } = cloudInstallWizard;
    setCloudInstallWizard(null);
    await openCloudInstalledAppWithChat(createChat, {
      appId,
      appTitle,
      agentMessage: buildCloudInstallWelcomeMessage({
        appId,
        appTitle,
        mode: "fork",
      }),
    });
  }, [cloudInstallWizard, createChat]);

  const continueFromOptionalDeps = useCallback(async () => {
    if (!optionalDepsNotice) return;
    const { appId, appTitle } = optionalDepsNotice;
    setOptionalDepsNotice(null);
    await openCloudInstalledAppWithChat(createChat, {
      appId,
      appTitle,
      agentMessage: buildCloudInstallWelcomeMessage({
        appId,
        appTitle,
        mode: "fork",
      }),
    });
  }, [optionalDepsNotice, createChat]);

  const openCommunityAppsFromOptionalDeps = useCallback(() => {
    setOptionalDepsNotice(null);
    window.dispatchEvent(new CustomEvent("papr-open-community-apps"));
  }, []);

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
    optionalDepsNotice,
    setOptionalDepsNotice,
    continueFromOptionalDeps,
    openCommunityAppsFromOptionalDeps,
    installCloudApp,
    startCloudInstall,
    resolveLocalAppId,
    finishInstallWizard,
    openInstallHelp,
    openAgentDatabaseSetup,
  };
}
