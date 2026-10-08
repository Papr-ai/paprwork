/**
 * page.goto that survives navigations the site itself cancels.
 *
 * Playwright throws net::ERR_ABORTED (or "interrupted by another navigation")
 * when the page navigates away before the requested load commits. LinkedIn does
 * this constantly: /login bounces signed-in users to /feed, and Windows Chrome
 * often fires a profile/first-run redirect on a fresh Papr profile. The tab is
 * fine — only our goto promise lost the race — so surfacing it as a connect
 * failure (raw, with ANSI codes) blocked users who were one click from signing in.
 */

import type { Page } from "playwright";

const ABORTED_PATTERNS = [
  /net::ERR_ABORTED/i,
  /interrupted by another navigation/i,
  /Navigation to .* is interrupted/i,
  /frame was detached/i,
];

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

export function isAbortedNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ABORTED_PATTERNS.some((re) => re.test(message));
}

export async function gotoTolerant(
  page: Page,
  url: string,
  options: { timeout: number },
): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeout });
  } catch (error) {
    if (!isAbortedNavigationError(error)) {
      throw error instanceof Error ? new Error(stripAnsi(error.message)) : error;
    }
    console.warn(
      `[platformSafeGoto] Navigation to ${url} was superseded (${page.url()}) — continuing`,
    );
    // Let whatever replaced our navigation finish before callers read the page.
    await page
      .waitForLoadState("domcontentloaded", { timeout: Math.min(options.timeout, 15_000) })
      .catch(() => {});
  }
}
