/**
 * Cross-process signal that the gateway is running a long sync/upload.
 * Electron supervisor reads this when /health times out so it does not SIGKILL
 * a live gateway that is busy pushing Turso/git (Upload now).
 */

import * as fs from "fs";
import * as path from "path";
import { getPaprDataDir } from "../../../core/utils/paprRoot.js";

export const GATEWAY_SYNC_BUSY_FILENAME = ".gateway-sync-busy.json";

export interface GatewaySyncBusyState {
  appId: string;
  operation: "flush" | "cloud_init";
  startedAtMs: number;
  trigger?: string;
  /** Apps waiting in namespace flush queue (excluding active app). */
  queueDepth?: number;
  queuedAppIds?: string[];
}

function busyStatePath(paprDir?: string): string {
  const dataDir = paprDir ? path.join(paprDir, "data") : getPaprDataDir();
  return path.join(dataDir, GATEWAY_SYNC_BUSY_FILENAME);
}

export function markGatewaySyncBusy(
  state: GatewaySyncBusyState,
  paprDir?: string,
): void {
  const filePath = busyStatePath(paprDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, "utf8");
}

export function clearGatewaySyncBusy(paprDir?: string): void {
  const filePath = busyStatePath(paprDir);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already clear */
  }
}

export function readGatewaySyncBusyState(
  paprDir?: string,
): GatewaySyncBusyState | null {
  const filePath = busyStatePath(paprDir);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as GatewaySyncBusyState;
    if (
      typeof parsed.appId !== "string" ||
      typeof parsed.startedAtMs !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** True when supervisor should not treat a health timeout as a gateway death. */
export function isGatewaySyncBusyGraceActive(
  state: GatewaySyncBusyState | null,
  nowMs: number = Date.now(),
  maxAgeMs: number = 15 * 60_000,
): boolean {
  if (!state) {
    return false;
  }
  return nowMs - state.startedAtMs >= 0 && nowMs - state.startedAtMs < maxAgeMs;
}

export function resolveGatewaySyncBusyPathForPaprHome(paprHome: string): string {
  return path.join(paprHome, "data", GATEWAY_SYNC_BUSY_FILENAME);
}
