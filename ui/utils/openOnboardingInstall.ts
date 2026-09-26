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
import { userProvidedRequirements, type CloudInstallResponse } from "./cloudCatalogInstall";
import {
  buildCloudInstallWelcomeMessage,
  openCloudInstalledAppWithChat,
} from "./openCloudInstalledAppWithChat";
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

  let message =
    result.agentSetupMessage ??
    buildCloudInstallWelcomeMessage({
      appId,
      appTitle: title,
      mode: "fork",
      needsSeed: result.bootstrap?.needsSeed === true,
    });
  const keys = userProvidedRequirements(result.requirements ?? entry.requirements);
  if (keys.length > 0) {
    message += `\n- It needs ${keys.map((k) => k.name).join(", ")} before it can run — walk me through adding ${keys.length > 1 ? "them" : "it"}`;
  }

  await openCloudInstalledAppWithChat(async () => createTempChat(), {
    appId,
    appTitle: title,
    agentMessage: message,
  });
}
