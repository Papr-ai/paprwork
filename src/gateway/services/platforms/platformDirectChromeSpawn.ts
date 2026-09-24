/**
 * Spawn Google Chrome directly (Chrome Manager pattern) instead of Playwright launch.
 * Minimal flags — real Chrome window, CDP on :9222 for jobs/agent attach.
 */

import { execSync, spawn } from "node:child_process";
import { getGoogleChromeExecutablePath } from "./platformChromeEnv.js";

const CDP_READY_POLL_MS = 250;
const CDP_READY_TIMEOUT_MS = 30_000;

/** Chrome Manager used only profile + CDP — minimal flags. Avoid unsupported flags (Chrome shows a banner that breaks LinkedIn). */
export const DIRECT_CHROME_BASE_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  /** Automation profile must not load Grammarly/React DevTools/etc. — strong PX signal. */
  "--disable-extensions",
] as const;

export function resolvePlatformCdpPort(): number {
  const fromEnv = process.env.PAPR_PLATFORM_CDP_PORT ?? process.env.LINKEDIN_CHROME_CDP_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 9222;
}

export function buildPlatformCdpUrl(port: number = resolvePlatformCdpPort()): string {
  return `http://127.0.0.1:${port}`;
}

export function buildDirectChromeSpawnArgs(options: {
  userDataDir: string;
  cdpPort?: number;
  startUrl?: string;
}): string[] {
  const port = options.cdpPort ?? resolvePlatformCdpPort();
  const args: string[] = [
    `--user-data-dir=${options.userDataDir}`,
    `--remote-debugging-port=${port}`,
    ...DIRECT_CHROME_BASE_ARGS,
  ];
  if (options.startUrl) {
    args.push(options.startUrl);
  }
  return args;
}

export async function isPlatformCdpReady(
  cdpUrl: string = buildPlatformCdpUrl(),
): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function getPidsListeningOnPort(port: number): number[] {
  try {
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" });
      const pids = new Set<number>();
      for (const line of output.split("\n")) {
        if (!line.includes("LISTENING")) {
          continue;
        }
        const parts = line.trim().split(/\s+/);
        const pid = Number.parseInt(parts[parts.length - 1] ?? "", 10);
        if (Number.isFinite(pid)) {
          pids.add(pid);
        }
      }
      return [...pids];
    }

    // -sTCP:LISTEN matters: without it lsof also reports every *client* with a
    // connection to the port — including this gateway after a CDP probe.
    const output = execSync(`lsof -nP -t -iTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
    }).trim();
    if (!output) {
      return [];
    }
    return output
      .split("\n")
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return [];
  }
}

function getProcessCommandLine(pid: number): string {
  try {
    if (process.platform === "win32") {
      return execSync(`wmic process where processid=${pid} get commandline /value`, {
        encoding: "utf8",
      }).trim();
    }
    return execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Electron is Chromium, so a bare "Chrome" match would also claim the app itself. */
export function looksLikeChromeCommandLine(commandLine: string): boolean {
  if (!commandLine || /Electron/i.test(commandLine)) {
    return false;
  }
  return (
    /Google Chrome|chrome\.exe|Chromium/i.test(commandLine) || commandLine.includes("Chrome")
  );
}

/** True when the process listening on `port` is Chrome using Papr's profile dir. */
export function isChromeUsingUserDataDir(port: number, userDataDir: string): boolean {
  const profileNeedle = `--user-data-dir=${userDataDir.replace(/\/$/, "")}`;
  for (const pid of getPidsListeningOnPort(port)) {
    const commandLine = getProcessCommandLine(pid);
    if (looksLikeChromeCommandLine(commandLine) && commandLine.includes(profileNeedle)) {
      return true;
    }
  }
  return false;
}

export type CdpPortHolderKind = "own_process" | "chrome" | "other";

export interface CdpPortHolder {
  pid: number;
  commandLine: string;
}

export interface CdpPortTakeoverPlan {
  killable: number[];
  blockedBy: Array<CdpPortHolder & { kind: Exclude<CdpPortHolderKind, "chrome"> }>;
}

/**
 * The gateway's parent is the Electron main process, which listens on
 * PAPR_PLATFORM_CDP_PORT when PAPR_PLATFORM_EMBEDDED_CDP=1 — signalling it quits the app.
 */
export function ownProcessPids(): ReadonlySet<number> {
  return new Set([process.pid, process.ppid]);
}

export function classifyCdpPortHolder(
  holder: CdpPortHolder,
  ownPids: ReadonlySet<number>,
): CdpPortHolderKind {
  if (ownPids.has(holder.pid)) {
    return "own_process";
  }
  return looksLikeChromeCommandLine(holder.commandLine) ? "chrome" : "other";
}

/** Only a separate Chrome is ever stopped; anything else blocks the takeover outright. */
export function planCdpPortTakeover(
  holders: readonly CdpPortHolder[],
  ownPids: ReadonlySet<number>,
): CdpPortTakeoverPlan {
  const plan: CdpPortTakeoverPlan = { killable: [], blockedBy: [] };
  for (const holder of holders) {
    const kind = classifyCdpPortHolder(holder, ownPids);
    if (kind === "chrome") {
      plan.killable.push(holder.pid);
    } else {
      plan.blockedBy.push({ ...holder, kind });
    }
  }
  return plan;
}

export function describeBlockedCdpPort(
  port: number,
  blockedBy: CdpPortTakeoverPlan["blockedBy"],
): string {
  if (blockedBy.some((holder) => holder.kind === "own_process")) {
    return (
      `Port ${port} is Paprwork's own DevTools endpoint, not a separate Chrome. ` +
      "PAPR_PLATFORM_EMBEDDED_CDP=1 makes the app listen on PAPR_PLATFORM_CDP_PORT, " +
      "which is also the port real Chrome is launched on. Unset " +
      "PAPR_PLATFORM_EMBEDDED_CDP and restart Paprwork to use browser tools."
    );
  }
  const first = blockedBy[0];
  const command = first ? first.commandLine.slice(0, 120) || "unknown command" : "unknown";
  return (
    `Port ${port} is held by a process that is not Chrome (pid ${first?.pid ?? "?"}: ${command}). ` +
    "Paprwork will not stop it — free the port or set PAPR_PLATFORM_CDP_PORT to another one."
  );
}

export async function killChromeListeningOnPort(port: number): Promise<void> {
  const holders = getPidsListeningOnPort(port).map((pid) => ({
    pid,
    commandLine: getProcessCommandLine(pid),
  }));
  if (holders.length === 0) {
    return;
  }

  // Stopping only the Chrome would not free the port anyway, so refuse before signalling anyone.
  const plan = planCdpPortTakeover(holders, ownProcessPids());
  if (plan.blockedBy.length > 0) {
    throw new Error(describeBlockedCdpPort(port, plan.blockedBy));
  }

  const killable = new Set(plan.killable);
  const stillListening = (): number[] =>
    getPidsListeningOnPort(port).filter((pid) => killable.has(pid));

  for (const pid of killable) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already exited */
    }
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (stillListening().length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  for (const pid of stillListening()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
}

export function isCdpAttachUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Browser\.setDownloadBehavior/i.test(message) ||
    /Browser context management is not supported/i.test(message)
  );
}

async function waitForPlatformCdpReady(
  cdpUrl: string,
  timeoutMs: number = CDP_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPlatformCdpReady(cdpUrl)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_READY_POLL_MS));
  }
  throw new Error(
    `Chrome did not expose CDP at ${cdpUrl} within ${timeoutMs / 1000}s. ` +
      "If another app uses port 9222, close it and try again.",
  );
}

export interface DirectChromeSpawnResult {
  cdpUrl: string;
  pid: number | undefined;
}

/**
 * Launch Google Chrome as a detached process (Chrome Manager style).
 * Does not use Playwright — caller attaches via connectOverCDP afterward.
 */
export async function spawnDirectGoogleChrome(options: {
  userDataDir: string;
  startUrl?: string;
  cdpPort?: number;
  /** Kill any Chrome on the CDP port and launch a fresh Papr profile instance. */
  forceRespawn?: boolean;
}): Promise<DirectChromeSpawnResult> {
  const executable = getGoogleChromeExecutablePath();
  if (!executable) {
    throw new Error("Google Chrome is not installed.");
  }

  const cdpPort = options.cdpPort ?? resolvePlatformCdpPort();
  const cdpUrl = buildPlatformCdpUrl(cdpPort);

  if (options.forceRespawn) {
    console.log(`[DirectChromeSpawn] forceRespawn — stopping Chrome on port ${cdpPort}`);
    await killChromeListeningOnPort(cdpPort);
  } else if (await isPlatformCdpReady(cdpUrl)) {
    if (isChromeUsingUserDataDir(cdpPort, options.userDataDir)) {
      console.log(`[DirectChromeSpawn] Reusing Papr Chrome profile on ${cdpUrl}`);
      return { cdpUrl, pid: undefined };
    }
    console.log(
      `[DirectChromeSpawn] Port ${cdpPort} is in use by another Chrome — stopping it for Papr profile`,
    );
    await killChromeListeningOnPort(cdpPort);
  }

  const args = buildDirectChromeSpawnArgs({
    userDataDir: options.userDataDir,
    cdpPort,
    startUrl: options.startUrl,
  });

  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  console.log(
    `[DirectChromeSpawn] Spawned Google Chrome (pid=${child.pid ?? "unknown"}) profile=${options.userDataDir}`,
  );

  await waitForPlatformCdpReady(cdpUrl);
  return { cdpUrl, pid: child.pid ?? undefined };
}
