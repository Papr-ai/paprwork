/**
 * Launch real Google Chrome without Playwright's default automation flags.
 * Used only for Playwright fallback when Google Chrome is unavailable (connectViaPlaywright).
 * Platform connections spawn Chrome directly — see platformDirectChromeSpawn.ts.
 */

import type { BrowserContext } from "playwright";

/** Playwright injects this by default — causes automation banner + webdriver detection. */
export const REAL_CHROME_IGNORE_DEFAULT_ARGS = ["--enable-automation"] as const;

export const REAL_CHROME_LAUNCH_ARGS = [
  "--remote-debugging-port=9222",
] as const;

export interface RealChromePersistentLaunchOptions {
  headless: false;
  channel?: "chrome";
  args: string[];
  ignoreDefaultArgs: string[];
  chromiumSandbox?: boolean;
  viewport: { width: number; height: number };
  locale: string;
  userAgent?: string;
}

export function buildRealChromePersistentLaunchOptions(options?: {
  includeCdpPort?: boolean;
  channel?: "chrome" | "chromium";
}): RealChromePersistentLaunchOptions {
  const useChrome = options?.channel !== "chromium";
  const includeCdp = options?.includeCdpPort !== false;
  const args = includeCdp
    ? [...REAL_CHROME_LAUNCH_ARGS]
    : REAL_CHROME_LAUNCH_ARGS.filter((arg) => !arg.startsWith("--remote-debugging-port"));

  const launch: RealChromePersistentLaunchOptions = {
    headless: false,
    args,
    ignoreDefaultArgs: [...REAL_CHROME_IGNORE_DEFAULT_ARGS],
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  };

  if (useChrome) {
    launch.channel = "chrome";
    // Playwright adds --no-sandbox unless this is true (shows ugly unsupported-flag banner).
    launch.chromiumSandbox = true;
  }

  return launch;
}

/** Patch common automation signals on every document in the profile. */
export async function applyRealChromeStealthScripts(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
      configurable: true,
    });
  });
}
