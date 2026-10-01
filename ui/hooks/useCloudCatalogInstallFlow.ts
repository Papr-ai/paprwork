/**
 * Shared fork/track install flow for Team and Community cloud apps.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CommunityCatalogEntry,
  CommunityCatalogScope,
} from "../../src/core/types/communityCatalog";
import { resolveOneInstallSelection } from "../../src/core/utils/cloudCatalogInstallPolicy";
import { useArtifacts } from "./useArtifacts";
import { useChat } from "./useChat";
import { useTabs } from "./useTabs";
import { trackEvent } from "../lib/telemetry";
import {
  fetchCloudLineageIndex,
  extractOptionalInstallDependencies,
  buildPostInstallAgentMessage,
  installCloudCatalogApp,
  planCloudInstallFailureHandoff,
  type CloudCatalogInstallSelection,
} from "../utils/cloudCatalogInstall";
import { openCloudInstalledAppWithChat } from "../utils/openCloudInstalledAppWithChat";
import type { CloudAppDependenciesFile } from "../../src/core/types/cloudAppDependencies";
import {
  resolveLocalAppIdForCatalogEntry,
  type CloudLineageIndex,
} from "../utils/communityAppLocalOpen";

export function useCloudCatalogInstallFlow() {
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installToast, setInstallToast] = useState<string | null>(null);
  const [lineageIndex, setLineageIndex] = useState<CloudLineageIndex | null>(null);
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
          const plan = planCloudInstallFailureHandoff(entry, mode, result);
          if (plan.kind === "agent") {
            setInstallToast(plan.toast);
            void openAgentDatabaseSetup(plan.agentMessage);
            return;
          }
          throw new Error(plan.message);
        }

        const body = result.data;
        const title = body.app?.title ?? entry.name;
        const modeLabel = "Installed";
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
        void refreshLineage();

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
          err instanceof Error ? err.message.slice(0, 240) : "Install failed";
        const plan = planCloudInstallFailureHandoff(entry, mode, {
          ok: false,
          error: message,
        });
        if (plan.kind === "agent") {
          setInstallToast(plan.toast);
          void openAgentDatabaseSetup(plan.agentMessage);
        } else {
          setInstallToast(`Install failed for "${entry.name}": ${plan.message}`);
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
      // v5: one Install. No Copy vs Collaborate choice; the copy is linked
      // and the data choice lives on the bar (Data switch / Detach).
      void installCloudApp(
        entry,
        resolveOneInstallSelection({
          catalogScope,
          visibility: entry.visibility,
          codeInstallable: entry.codeInstallable,
        }),
        catalogScope,
      );
    },
    [installCloudApp],
  );

  const resolveLocalAppId = useCallback(
    (entry: CommunityCatalogEntry) =>
      resolveLocalAppIdForCatalogEntry(entry, installedAppIds, lineageIndex),
    [installedAppIds, lineageIndex],
  );

  const continueFromOptionalDeps = useCallback(async () => {
    if (!optionalDepsNotice) return;
    const { appId, appTitle } = optionalDepsNotice;
    setOptionalDepsNotice(null);
    await openCloudInstalledAppWithChat(createChat, {
      appId,
      appTitle,
      agentMessage: buildPostInstallAgentMessage({
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
    async (request: {
      service: string;
      keyName: string;
      instructions?: string;
      signupUrl?: string;
      docsUrl?: string;
    }) => {
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
    installingId,
    installToast,
    optionalDepsNotice,
    setOptionalDepsNotice,
    continueFromOptionalDeps,
    openCommunityAppsFromOptionalDeps,
    installCloudApp,
    startCloudInstall,
    resolveLocalAppId,
    openInstallHelp,
    openAgentDatabaseSetup,
  };
}
