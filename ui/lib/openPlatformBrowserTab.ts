import { PLATFORM_TAB_ICON } from "../components/Platform/PlatformBrowserTab";
import { useTabStore } from "../stores/tabStore";
import {
  isPlatformTabMergedWithChat,
  resolveChatTabForPlatformMerge,
} from "../utils/appTabMerge";
import { isUserOnChatTab } from "../utils/resolveAppIdForAutoOpen";

const PLATFORM_TITLES: Record<string, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
  reddit: "Reddit",
  facebook: "Facebook",
  tiktok: "TikTok",
  twitter: "X / Twitter",
  telegram: "Telegram",
};

export interface OpenPlatformBrowserTabOptions {
  title?: string;
  /** When set, opens platform beside chat (split view) instead of full-screen tab steal. */
  mergeWithChatTabId?: string;
  /** When merging: switch focus to chat parent (split). Default: true if user is on chat. */
  autoSwitch?: boolean;
}

export function openPlatformBrowserTab(
  platformId: string,
  options?: OpenPlatformBrowserTabOptions | string,
): string {
  const opts: OpenPlatformBrowserTabOptions =
    typeof options === "string" ? { title: options } : (options ?? {});

  const resolvedTitle = opts.title ?? PLATFORM_TITLES[platformId] ?? platformId;
  const icon = PLATFORM_TAB_ICON[platformId];
  const { createTab, createArtifactFromChat, switchToTab, getTab, activeTabId } =
    useTabStore.getState();
  const tabId = `platform-${platformId}`;

  if (!getTab(tabId)) {
    createTab("platform", platformId, resolvedTitle, icon ? { icon } : undefined);
  }

  const mergeChatTabId =
    opts.mergeWithChatTabId ?? resolveChatTabForPlatformMerge();

  if (mergeChatTabId) {
    const autoSwitch =
      opts.autoSwitch ??
      isUserOnChatTab(mergeChatTabId, activeTabId, getTab);

    if (isPlatformTabMergedWithChat(mergeChatTabId, tabId)) {
      if (autoSwitch) {
        switchToTab(mergeChatTabId);
      }
      return tabId;
    }

    createArtifactFromChat(mergeChatTabId, tabId, { autoSwitch });
    return tabId;
  }

  switchToTab(tabId);
  return tabId;
}
