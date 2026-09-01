/**
 * Shared helpers for detecting Google Chrome on the host machine.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

export function isGoogleChromeInstalled(): boolean {
  if (process.platform === "darwin") {
    return existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    return (
      existsSync(join(localAppData, "Google", "Chrome", "Application", "chrome.exe")) ||
      existsSync(join(programFiles, "Google", "Chrome", "Application", "chrome.exe"))
    );
  }
  try {
    execSync("which google-chrome || which google-chrome-stable", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
