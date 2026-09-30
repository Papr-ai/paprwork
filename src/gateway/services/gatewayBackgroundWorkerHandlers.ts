/**
 * Background child task handlers (Phase C).
 */

import type { GatewayBackgroundRpcMethod } from "./gatewayBackgroundWorkerProtocol.js";
import {
  pushVaultEntriesViaGatewayHttp,
  type VaultSyncPushResult,
} from "./vaultSyncBackgroundPush.js";
import type { CloudVaultKeyEntry } from "../../core/utils/cloudReposScope.js";

export type BackgroundRpcFn = (
  method: GatewayBackgroundRpcMethod,
  payload?: unknown,
) => Promise<unknown>;

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT ?? "18789", 10);

export async function runBackgroundTaskInChild(
  taskKey: string,
  rpc: BackgroundRpcFn,
): Promise<void> {
  switch (taskKey) {
    case "papr:resume-cloud":
    case "vault:workspace-switch":
      await runVaultPushTaskInChild(rpc);
      return;
    default:
      throw new Error(`Unknown background task: ${taskKey}`);
  }
}

async function runVaultPushTaskInChild(rpc: BackgroundRpcFn): Promise<void> {
  const entries = (await rpc("vault-build-push-entries")) as CloudVaultKeyEntry[];
  if (!entries.length) {
    console.log("[GatewayBackgroundWorker] No vault entries to push");
    return;
  }

  console.log(
    `[GatewayBackgroundWorker] Pushing ${entries.length} vault key(s) via HTTP…`,
  );
  const result = await pushVaultEntriesViaGatewayHttp(GATEWAY_PORT, entries);
  if (!result) {
    return;
  }

  await rpc("vault-apply-push-result", result as VaultSyncPushResult);
}
