/**
 * Page-like adapter for agent browser tools targeting the in-app platform tab.
 */

import type { PlatformId } from "./platformRegistry.js";
import { requestPlatformBrowser } from "../../utils/platformBrowserBridge.js";

export class EmbeddedBrowserPageAdapter {
  private currentUrl = "";
  private currentTitle = "";

  constructor(private readonly platformId: PlatformId) {}

  async goto(
    url: string,
    _options?: { waitUntil?: string; timeout?: number },
  ): Promise<void> {
    const response = await requestPlatformBrowser({
      action: "navigate",
      payload: { platformId: this.platformId, url },
    });
    if (!response.success) {
      throw new Error(response.error ?? "Navigation failed");
    }
    const data = response.data as { url?: string; title?: string };
    this.currentUrl = data.url ?? url;
    this.currentTitle = data.title ?? "";
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    await this.refreshState();
    return this.currentTitle;
  }

  async content(): Promise<string> {
    const response = await requestPlatformBrowser({
      action: "snapshot",
      payload: { platformId: this.platformId, maxHtmlChars: 500_000 },
    });
    if (!response.success) {
      throw new Error(response.error ?? "Snapshot failed");
    }
    const data = response.data as { html?: string; url?: string; title?: string };
    if (data.url) {
      this.currentUrl = data.url;
    }
    if (data.title) {
      this.currentTitle = data.title;
    }
    return data.html ?? "";
  }

  async click(selector: string): Promise<void> {
    const response = await requestPlatformBrowser({
      action: "click",
      payload: { platformId: this.platformId, selector },
    });
    if (!response.success) {
      throw new Error(response.error ?? "Click failed");
    }
  }

  async fill(selector: string, text: string): Promise<void> {
    const response = await requestPlatformBrowser({
      action: "fill",
      payload: { platformId: this.platformId, selector, text },
    });
    if (!response.success) {
      throw new Error(response.error ?? "Fill failed");
    }
  }

  async evaluate(script: string): Promise<unknown> {
    const response = await requestPlatformBrowser({
      action: "execute",
      payload: { platformId: this.platformId, script },
    });
    if (!response.success) {
      throw new Error(response.error ?? "Script execution failed");
    }
    return (response.data as { result?: unknown } | undefined)?.result;
  }

  context(): { pages: () => never[] } {
    return {
      pages: () => [],
    };
  }

  private async refreshState(): Promise<void> {
    const response = await requestPlatformBrowser({
      action: "get_state",
      payload: { platformId: this.platformId },
    });
    if (!response.success || !response.data) {
      return;
    }
    const data = response.data as { url?: string; title?: string };
    if (data.url) {
      this.currentUrl = data.url;
    }
    if (data.title) {
      this.currentTitle = data.title;
    }
  }
}

let activeEmbeddedPlatformId: PlatformId | null = null;

export function bindEmbeddedPlatformSession(
  platformId: PlatformId,
): EmbeddedBrowserPageAdapter {
  activeEmbeddedPlatformId = platformId;
  return new EmbeddedBrowserPageAdapter(platformId);
}

export function getActiveEmbeddedPlatformId(): PlatformId | null {
  return activeEmbeddedPlatformId;
}

export function clearEmbeddedPlatformSession(): void {
  activeEmbeddedPlatformId = null;
}
