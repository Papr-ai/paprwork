/**
 * Vault push HTTP — safe to run in the background child (no keychain IPC).
 */

import {
  buildCloudVaultRequestBody,
  type CloudVaultKeyEntry,
} from "../../core/utils/cloudReposScope.js";
import {
  isPaprSubscriptionBlockedMessage,
  reportPaprQuotaError,
} from "../../core/utils/paprQuota.js";

export function resolveVaultPushTimeoutMs(): number {
  const raw = process.env.VAULT_PUSH_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 5_000) {
      return parsed;
    }
  }
  return 45_000;
}

export interface VaultSyncPushResult {
  synced: number;
  created: string[];
  updated: string[];
  unchanged?: string[];
  deleted: string[];
  conflicts?: Array<{
    name: string;
    reason?: string;
    ownerUserId?: string;
    shareScope?: string;
  }>;
}

export async function pushVaultEntriesViaGatewayHttp(
  gatewayPort: number,
  entries: CloudVaultKeyEntry[],
  workspaceSignal?: AbortSignal,
): Promise<VaultSyncPushResult | null> {
  if (entries.length === 0) {
    return null;
  }

  const { isVaultSyncPlatformPaused, getVaultSyncPlatformPauseReason } =
    await import("./vaultSyncPlatformBackoff.js");
  if (isVaultSyncPlatformPaused()) {
    const reason = getVaultSyncPlatformPauseReason();
    throw new Error(reason ?? "Vault sync paused after platform errors");
  }

  workspaceSignal?.throwIfAborted();
  const pushTimeoutMs = resolveVaultPushTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), pushTimeoutMs);

  try {
    const resp = await fetch(
      `http://127.0.0.1:${gatewayPort}/api/cloud/vault/sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCloudVaultRequestBody(entries, "user")),
        signal: workspaceSignal ? AbortSignal.any([controller.signal, workspaceSignal]) : controller.signal,
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      if (isPaprSubscriptionBlockedMessage(text)) {
        reportPaprQuotaError(
          new Error(`Vault sync failed (${resp.status}): ${text}`),
          "vault-sync",
        );
        throw Object.assign(new Error("No active subscription for vault sync"), { status: resp.status });
      }
      const { recordVaultSyncPlatformFailure } = await import(
        "./vaultSyncPlatformBackoff.js"
      );
      recordVaultSyncPlatformFailure(resp.status, text);
      throw Object.assign(new Error(`Vault sync failed (${resp.status}): ${text}`), { status: resp.status });
    }

    const { recordVaultSyncPlatformSuccess } = await import(
      "./vaultSyncPlatformBackoff.js"
    );
    recordVaultSyncPlatformSuccess();
    return (await resp.json()) as VaultSyncPushResult;
  } catch (err) {
    if (!workspaceSignal?.aborted && !(err && typeof err === "object" && "status" in err)) {
      const { recordVaultSyncPlatformFailure } = await import("./vaultSyncPlatformBackoff.js");
      recordVaultSyncPlatformFailure(503, controller.signal.aborted ? "Vault upload timed out" : "Vault upload transport failed");
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (isPaprSubscriptionBlockedMessage(msg)) {
      reportPaprQuotaError(err, "vault-sync");
      throw err;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
