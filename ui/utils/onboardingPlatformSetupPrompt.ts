import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";
import type { OnboardingRecommendation } from "../constants/onboardingRecommendations";

/** Prefilled chat message when onboarding needs platform connect but Chrome is missing. */
export function buildPlatformSetupChatPrompt(
  rec: OnboardingRecommendation,
  entry: CommunityCatalogEntry,
): string {
  const platformName = rec.connect!.label.replace(/^Connect\s+/i, "");
  return `I'm finishing Papr setup and want to use "${rec.title}" (the ${entry.name} app).

Google Chrome is not installed on this computer yet (or Papr couldn't find it). Please help me:

1. Check whether Google Chrome is installed; if not, install it with the right command for my OS (brew/winget — ask before running installs).
2. Connect my ${platformName} account using Papr's real Chrome sign-in window (Settings → Platform Connections or connect_platform request_connect — not the embedded Papr browser tab).
3. After ${platformName} shows as connected, help me install and personalize ${entry.name}.

${rec.connect!.why}

Go step by step and ask me to confirm before anything is sent on ${platformName}.`;
}

/** Prefilled chat when Settings or the agent modal needs Chrome before connect. */
export function buildSettingsPlatformSetupChatPrompt(
  platformName: string,
  platformId: string,
  options?: { reason?: string },
): string {
  const reasonBlock = options?.reason?.trim()
    ? `\nWhy I need this: ${options.reason.trim()}`
    : "";
  return `I need to connect ${platformName} in Papr (Settings → Platform Connections).

Google Chrome is not installed on this computer yet (or Papr couldn't find it). Please help me:

1. Check whether Google Chrome is installed; if not, install it with the right command for my OS (brew/winget — ask before running installs).
2. Connect my ${platformName} account using Papr's real Chrome sign-in (connect_platform with request_connect, or Settings → Platform Connections → Connect — not the embedded Papr browser tab).
3. Confirm ${platformName} shows as connected when finished.

Platform id: ${platformId}.${reasonBlock}

Go step by step and ask me to confirm before anything is sent on ${platformName}.`;
}
