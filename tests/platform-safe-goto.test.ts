import { describe, expect, it, vi } from "vitest";
import {
  gotoTolerant,
  isAbortedNavigationError,
  stripAnsi,
} from "../src/gateway/services/platforms/platformSafeGoto";

const WIN_ERROR =
  'page.goto: net::ERR_ABORTED at https://www.linkedin.com/login\nCall log:\n\u001b[2m  - navigating to "https://www.linkedin.com/login", waiting until "domcontentloaded"\u001b[22m';

function fakePage(gotoError?: Error) {
  return {
    goto: vi.fn(async () => {
      if (gotoError) throw gotoError;
    }),
    waitForLoadState: vi.fn(async () => {}),
    url: () => "https://www.linkedin.com/feed/",
  };
}

describe("platformSafeGoto", () => {
  it("treats a superseded navigation (Windows LinkedIn /login) as success", async () => {
    const page = fakePage(new Error(WIN_ERROR));
    await expect(
      gotoTolerant(page as never, "https://www.linkedin.com/login", { timeout: 1000 }),
    ).resolves.toBeUndefined();
    expect(page.waitForLoadState).toHaveBeenCalled();
  });

  it("still throws real failures, without ANSI codes", async () => {
    const page = fakePage(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED\u001b[2m x\u001b[22m"));
    await expect(
      gotoTolerant(page as never, "https://x.test", { timeout: 1000 }),
    ).rejects.toThrow(/^page\.goto: net::ERR_NAME_NOT_RESOLVED x$/);
  });

  it("detects aborted errors and strips ANSI", () => {
    expect(isAbortedNavigationError(new Error(WIN_ERROR))).toBe(true);
    expect(stripAnsi(WIN_ERROR)).not.toMatch(/\u001b/);
  });
});
