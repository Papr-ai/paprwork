/**
 * Per-namespace record of last successful deferred home/workspace boot.
 */

import { promises as fs } from "fs";
import path from "path";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";

const STATE_FILENAME = "gateway-deferred-boot.json";

export interface GatewayDeferredBootState {
  appliedEpoch: number;
  goalsWorkspaceFingerprint: string;
  completedAt: string;
}

export function gatewayDeferredBootStatePath(): string {
  return path.join(getPaprDataDir(), STATE_FILENAME);
}

export async function loadGatewayDeferredBootState(): Promise<
  GatewayDeferredBootState | null
> {
  try {
    const raw = await fs.readFile(gatewayDeferredBootStatePath(), "utf8");
    const parsed = JSON.parse(raw) as GatewayDeferredBootState;
    if (
      typeof parsed.appliedEpoch === "number" &&
      typeof parsed.goalsWorkspaceFingerprint === "string" &&
      typeof parsed.completedAt === "string"
    ) {
      return parsed;
    }
  } catch {
    /* first run or corrupt */
  }
  return null;
}

export async function saveGatewayDeferredBootState(
  state: GatewayDeferredBootState,
): Promise<void> {
  const target = gatewayDeferredBootStatePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(state, null, 2), "utf8");
}

export async function clearGatewayDeferredBootState(): Promise<void> {
  try {
    await fs.unlink(gatewayDeferredBootStatePath());
  } catch {
    /* absent */
  }
}
