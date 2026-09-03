/**
 * Shared helpers for detecting Google Chrome on the host machine.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const MACOS_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function getGoogleChromeExecutablePath(): string | null {
  if (process.platform === "darwin") {
    return existsSync(MACOS_CHROME_PATH) ? MACOS_CHROME_PATH : null;
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const candidates = [
      join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    ];
    return candidates.find((path) => existsSync(path)) ?? null;
  }
  try {
    const stdout = execSync("which google-chrome || which google-chrome-stable", {
      encoding: "utf8",
    }).trim();
    return stdout.length > 0 ? stdout : null;
  } catch {
    return null;
  }
}

export function isGoogleChromeInstalled(): boolean {
  return getGoogleChromeExecutablePath() !== null;
}
