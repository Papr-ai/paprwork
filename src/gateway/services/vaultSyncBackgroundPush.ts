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
        signal: controller.signal,
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      if (isPaprSubscriptionBlockedMessage(text)) {
        reportPaprQuotaError(
          new Error(`Vault sync failed (${resp.status}): ${text}`),
          "vault-sync",
        );
        return null;
      }
      const { recordVaultSyncPlatformFailure } = await import(
        "./vaultSyncPlatformBackoff.js"
      );
      recordVaultSyncPlatformFailure(resp.status, text);
      throw new Error(`Vault sync failed (${resp.status}): ${text}`);
    }

    const { recordVaultSyncPlatformSuccess } = await import(
      "./vaultSyncPlatformBackoff.js"
    );
    recordVaultSyncPlatformSuccess();
    return (await resp.json()) as VaultSyncPushResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isPaprSubscriptionBlockedMessage(msg)) {
      reportPaprQuotaError(err, "vault-sync");
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
