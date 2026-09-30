/**
 * After an onboarding install finishes: open the app beside a chat and send
 * the welcome message.
 *
 * Runs AFTER the auth gate releases (the workspace must be mounted for the
 * send event to land), so it is store-only — the gated screen is gone. Key
 * requirements are folded into the message instead of the Community tab's
 * wizard modal, which onboarding has no host for.
 */

import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";
import { ONBOARDING_RECOMMENDATIONS } from "../constants/onboardingRecommendations";
import {
  buildPostInstallAgentMessage,
  type CloudInstallResponse,
} from "./cloudCatalogInstall";
import { openCloudInstalledAppWithChat } from "./openCloudInstalledAppWithChat";
import { createTempChat, openChatWithPrompt } from "./openChatWithPrompt";

export async function openOnboardingInstall(
  entry: CommunityCatalogEntry,
  result: CloudInstallResponse,
): Promise<void> {
  const appId = result.app?.id;
  const title = result.app?.title ?? entry.name;
  if (!appId) {
    openChatWithPrompt(
      `I just installed "${entry.name}" during setup but it isn't showing in my workspace. Check the install and help me get it running.`,
    );
    return;
  }

  const rec = ONBOARDING_RECOMMENDATIONS.find((r) => r.slug === entry.slug);

  const message = buildPostInstallAgentMessage({
    appId,
    appTitle: title,
    mode: "fork",
    needsSeed: result.bootstrap?.needsSeed === true,
    catalogDescription: entry.description || rec?.desc,
    requirements: result.requirements ?? entry.requirements,
    agentSetupMessage: result.agentSetupMessage,
    platformConnect: rec?.connect
      ? {
          platformId: rec.connect.platformId,
          label: rec.connect.label,
          why: rec.connect.why,
        }
      : undefined,
  });

  await openCloudInstalledAppWithChat(async () => createTempChat(), {
    appId,
    appTitle: title,
    agentMessage: message,
  });
}
