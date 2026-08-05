/**
 * Detect OS-specific platform signals in app/job source and commands.
 */

import * as fs from "fs/promises";
import * as path from "path";

export type CatalogPlatform = "macos" | "windows" | "linux";

export interface PlatformSignals {
  macos: boolean;
  windows: boolean;
  linux: boolean;
}

const MACOS_INDICATORS = [
  /\bosascript\b/,
  /\bopen\s+-a\b/,
  /\bpbcopy\b/,
  /\bpbpaste\b/,
  /\bafplay\b/,
  /\bsay\b/,
  /\bbrew\s+(install|tap|cask)\b/,
  /\bdefaults\s+(write|read|delete)\b/,
  /\blaunchctl\b/,
  /\bAppleScript\b/i,
  /\/usr\/local\//,
  /\.app\b/,
  /\bsox\b/,
  /\brec\b.*\baudio\b/i,
  /\bEventKit\b/,
  /\bCoreAudio\b/,
  /\bAVFoundation\b/,
  /\bNSWorkspace\b/,
  /\bAppKit\b/,
  /\bCocoa\b/,
  /\bpyobjc\b/i,
  /\bterminal-notifier\b/,
  /\bstat\s+-f%/,
  /\bsecurity\s+(find-identity|import|create-keychain)\b/,
  /\bcodesign\b/,
  /\bxcrun\b/,
  /\bxcode-select\b/,
  /\bmdfind\b/,
  /\bmdls\b/,
  /\/Library\/(Application Support|Preferences|LaunchAgents)\//,
  /\bScreenCaptureKit\b/,
  /\bCalendar\.app\b/,
];

const WINDOWS_INDICATORS = [
  /\bpowershell\b/i,
  /\bcmd\.exe\b/i,
  /\breg\.exe\b/i,
  /\bnet\s+start\b/i,
  /[A-Z]:\\/,
  /\.bat\b/,
  /\.ps1\b/,
  /\bchoco\s+install\b/i,
];

const LINUX_INDICATORS = [
  /\bapt-get\b/,
  /\bapt\s+install\b/,
  /\bsystemctl\b/,
  /\bjournalctl\b/,
  /\/etc\/init\.d\//,
  /\byum\s+install\b/,
  /\bdnf\s+install\b/,
  /\bpacman\s+-S\b/,
];

export const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".swift",
  ".html",
  ".css",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".cfg",
  ".ini",
  ".env",
  ".sql",
]);

export function scanTextForPlatformSignals(text: string): PlatformSignals {
  const signals: PlatformSignals = {
    macos: false,
    windows: false,
    linux: false,
  };

  for (const pattern of MACOS_INDICATORS) {
    if (pattern.test(text)) {
      signals.macos = true;
      break;
    }
  }
  for (const pattern of WINDOWS_INDICATORS) {
    if (pattern.test(text)) {
      signals.windows = true;
      break;
    }
  }
  for (const pattern of LINUX_INDICATORS) {
    if (pattern.test(text)) {
      signals.linux = true;
      break;
    }
  }

  return signals;
}

export function mergePlatformSignals(
  ...groups: PlatformSignals[]
): PlatformSignals {
  return {
    macos: groups.some((group) => group.macos),
    windows: groups.some((group) => group.windows),
    linux: groups.some((group) => group.linux),
  };
}

export function platformsFromSignals(signals: PlatformSignals): CatalogPlatform[] {
  if (!signals.macos && !signals.windows && !signals.linux) {
    return ["macos", "windows", "linux"];
  }

  const platforms: CatalogPlatform[] = [];
  if (signals.macos) platforms.push("macos");
  if (signals.windows) platforms.push("windows");
  if (signals.linux) platforms.push("linux");
  return platforms;
}

export function scanFileContentsForPlatformSignals(
  fileContents: Map<string, string>,
): PlatformSignals {
  let merged: PlatformSignals = { macos: false, windows: false, linux: false };

  for (const [filename, content] of fileContents.entries()) {
    const ext = path.extname(filename).toLowerCase();
    if (ext === ".swift") {
      merged = mergePlatformSignals(merged, {
        macos: true,
        windows: false,
        linux: false,
      });
      continue;
    }
    if (ext === ".bat" || ext === ".ps1") {
      merged = mergePlatformSignals(merged, {
        macos: false,
        windows: true,
        linux: false,
      });
      continue;
    }
    merged = mergePlatformSignals(merged, scanTextForPlatformSignals(content));
  }

  return merged;
}

export async function detectPlatformsFromDirectory(
  jobs: Array<{ command?: string; type: string }>,
  rootPath: string,
): Promise<CatalogPlatform[]> {
  let signals: PlatformSignals = { macos: false, windows: false, linux: false };

  for (const job of jobs) {
    if (job.type === "swift") {
      signals = mergePlatformSignals(signals, {
        macos: true,
        windows: false,
        linux: false,
      });
    }
    if (job.command) {
      signals = mergePlatformSignals(
        signals,
        scanTextForPlatformSignals(job.command),
      );
    }
  }

  async function scanDir(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(full);
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".swift") {
        signals = mergePlatformSignals(signals, {
          macos: true,
          windows: false,
          linux: false,
        });
        continue;
      }
      if (ext === ".bat" || ext === ".ps1") {
        signals = mergePlatformSignals(signals, {
          macos: false,
          windows: true,
          linux: false,
        });
        continue;
      }
      if (!TEXT_EXTENSIONS.has(ext)) continue;

      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.size > 512 * 1024) continue;

      let content: string;
      try {
        content = await fs.readFile(full, "utf8");
      } catch {
        continue;
      }

      signals = mergePlatformSignals(signals, scanTextForPlatformSignals(content));
    }
  }

  await scanDir(rootPath);
  return platformsFromSignals(signals);
}
