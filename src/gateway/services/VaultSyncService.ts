/**
 * Vault Sync Service — syncs local custom keys (macOS Keychain) to cloud vault
 * (GCP Secret Manager) via the memory server.
 *
 * Flow:
 *   1. On init: push all local keys → cloud vault (idempotent)
 *   2. On init: pull vault key names → add any missing to local keychain
 *   3. On key change: push updated keys → cloud vault
 *
 * The cloud proxy at /api/cloud/vault/* forwards to /v1/cloud/vault/*
 * on the memory server, attaching the user's PAPR_API_KEY automatically.
 */

import {
  buildCloudVaultRequestBody,
  mapCustomKeyMetadataToVaultEntry,
} from "../../core/utils/cloudReposScope.js";
import type { CloudRepoScope, CloudVaultKeyEntry } from "../../core/utils/cloudReposScope.js";
import { readActiveWorkspacePointer } from "../../core/utils/paprWorkspace.js";
import { getCustomKeysService } from "./CustomKeysService.js";
import { resolveVaultKeySource } from "./cloudAgentGateway/resolveCloudProviderAuth.js";
import { getPaprApiKey } from "../utils/keyResolver.js";

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT ?? "18789", 10);
const PUSH_TIMEOUT_MS = 120_000; // 52 keys × ~2s each on GCP Secret Manager
const PULL_TIMEOUT_MS = 15_000;

interface VaultKeyInfo {
  name: string;
  syncedAt: string;
}

interface VaultSyncResponse {
  synced: number;
  created: string[];
  updated: string[];
  deleted: string[];
}

interface VaultListKeysResponse {
  keys: VaultKeyInfo[];
}

type VaultSyncStatus = "idle" | "syncing" | "error" | "disabled";

interface VaultState {
  status: VaultSyncStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  keyCount: number;
}

export class VaultSyncService {
  private state: VaultState = {
    status: "idle",
    lastSyncAt: null,
    lastError: null,
    keyCount: 0,
  };

  private readonly gatewayPort: number;

  constructor(opts?: { gatewayPort?: number }) {
    this.gatewayPort = opts?.gatewayPort ?? GATEWAY_PORT;
  }

  getState(): VaultState {
    return { ...this.state };
  }

  /**
   * Initialize: push local keys to cloud, then pull to discover cross-device keys.
   */
  async initialize(): Promise<void> {
    console.log("[VaultSync] Initializing...");

    const paprKey = await getPaprApiKey();
    if (!paprKey) {
      console.warn("[VaultSync] No PAPR_API_KEY — vault sync disabled");
      this.state.status = "disabled";
      return;
    }

    try {
      const pushed = await this.pushAllKeys();
      await this.pullKeys();
      if (!pushed) {
        // Gateway may start before Electron IPC is ready; retry once keys are readable.
        setTimeout(() => {
          void this.pushAllKeys().then((retry) => {
            if (retry) {
              console.log(
                `[VaultSync] Delayed push synced ${retry.synced} keys`,
              );
            }
          });
        }, 15_000);
      }
      console.log(
        `[VaultSync] Ready — ${this.state.keyCount} keys synced`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      console.error("[VaultSync] Init failed:", msg);
      this.state.status = "error";
      this.state.lastError = msg;
    }
  }

  /**
   * Push all local custom keys to the cloud vault.
   * Called on init and after any key add/update/delete.
   */
  async pushAllKeys(): Promise<VaultSyncResponse | null> {
    const customKeys = getCustomKeysService();

    const keyList = await customKeys.listKeys();
    if (keyList.length === 0) {
      console.log("[VaultSync] No local keys to push");
      this.state.keyCount = 0;
      return null;
    }

    const vaultEntries: CloudVaultKeyEntry[] = [];

    for (const meta of keyList) {
      if (meta.scope === "global") {
        continue;
      }
      try {
        const value = await customKeys.getKeyByName(meta.name);
        if (!value) {
          continue;
        }
        vaultEntries.push(
          mapCustomKeyMetadataToVaultEntry({
            meta,
            value,
            source: resolveVaultKeySource(
              {
                name: meta.name,
                source: meta.source,
                managedBy: meta.managedBy,
                oauthProvider: meta.oauthProvider,
                description: meta.description,
              },
              value,
            ),
          }),
        );
      } catch (err) {
        console.warn(
          `[VaultSync] Could not read key "${meta.name}":`,
          (err as Error).message,
        );
      }
    }

    if (vaultEntries.length === 0) {
      console.log("[VaultSync] No readable key values to push");
      return null;
    }

    this.state.status = "syncing";
    console.log(
      `[VaultSync] Pushing ${vaultEntries.length} keys to vault (per-key shareScope)...`,
    );

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

      const resp = await fetch(
        `http://localhost:${this.gatewayPort}/api/cloud/vault/sync`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            buildCloudVaultRequestBody(vaultEntries, "user"),
          ),
          signal: controller.signal,
        },
      );

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Vault sync failed (${resp.status}): ${text}`);
      }

      clearTimeout(timer);

      const result = (await resp.json()) as VaultSyncResponse;
      this.state.status = "idle";
      this.state.lastSyncAt = new Date().toISOString();
      this.state.lastError = null;
      this.state.keyCount = vaultEntries.length;

      console.log(
        `[VaultSync] Pushed ${result.synced} keys (${result.created.length} created, ${result.updated.length} updated)`,
      );
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      this.state.status = "error";
      this.state.lastError = msg;
      console.error("[VaultSync] Push failed:", msg);
      return null;
    }
  }

  private vaultPullScopes(): CloudRepoScope[] {
    const pointer = readActiveWorkspacePointer();
    const scopes: CloudRepoScope[] = ["user"];
    if (pointer?.namespaceId || process.env.PAPR_NAMESPACE_ID?.trim()) {
      scopes.push("namespace");
    }
    if (pointer?.organizationId) {
      scopes.push("org");
    }
    return scopes;
  }

  private async fetchVaultKeyNamesForScope(
    scope: CloudRepoScope,
    signal: AbortSignal,
  ): Promise<string[]> {
    const { scope: resolvedScope, namespace_id: namespaceId } =
      buildCloudVaultRequestBody([], scope);
    const params = new URLSearchParams({ scope: resolvedScope });
    if (namespaceId) {
      params.set("namespace_id", namespaceId);
    }

    const resp = await fetch(
      `http://localhost:${this.gatewayPort}/api/cloud/vault/keys?${params}`,
      { signal },
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(
        `[VaultSync] Pull failed for scope ${resolvedScope} (${resp.status}): ${text.slice(0, 120)}`,
      );
      return [];
    }

    const data = (await resp.json()) as VaultListKeysResponse;
    return data.keys.map((k) => k.name);
  }

  /**
   * Pull vault key names and add any missing keys to local keychain.
   * Values are NOT pulled (would require a resolve endpoint). Only names
   * are checked so the user knows which keys exist across devices.
   */
  async pullKeys(): Promise<string[]> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);

      const vaultKeyNames = new Set<string>();
      for (const scope of this.vaultPullScopes()) {
        const names = await this.fetchVaultKeyNamesForScope(
          scope,
          controller.signal,
        );
        for (const name of names) {
          vaultKeyNames.add(name);
        }
      }

      clearTimeout(timer);

      const allNames = [...vaultKeyNames];
      const customKeys = getCustomKeysService();
      const localKeys = await customKeys.listKeys();
      const localNames = new Set(localKeys.map((k) => k.name));

      const missingLocally = allNames.filter((n) => !localNames.has(n));

      if (missingLocally.length > 0) {
        console.log(
          `[VaultSync] Found ${missingLocally.length} vault keys not in local keychain: ${missingLocally.join(", ")}`,
        );
        // We log but don't auto-add — values aren't available from list endpoint.
        // The user would need to re-add them or we'd need a resolve endpoint for pull.
      }

      return allNames;
    } catch (err) {
      console.warn("[VaultSync] Pull failed:", (err as Error).message);
      return [];
    }
  }

  /** Push + pull after org/namespace workspace switch (non-blocking). */
  syncForWorkspaceSwitch(): void {
    console.log("[VaultSync] Re-syncing vault for workspace switch (background)...");
    void (async () => {
      try {
        await this.pushAllKeys();
        await this.pullKeys();
      } catch (err) {
        console.warn(
          "[VaultSync] Workspace switch re-sync failed:",
          (err as Error).message,
        );
      }
    })();
  }

  /**
   * Notify that a key was added or updated. Triggers a full push.
   */
  async onKeyChanged(keyName: string): Promise<void> {
    console.log(`[VaultSync] Key changed: ${keyName} — syncing to vault`);
    await this.pushAllKeys();
  }

  /**
   * Notify that a key was deleted. Triggers a full push (vault sync is
   * idempotent — server will detect removed keys and delete them).
   */
  async onKeyDeleted(keyName: string): Promise<void> {
    console.log(`[VaultSync] Key deleted: ${keyName} — syncing to vault`);
    await this.pushAllKeys();
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let instance: VaultSyncService | null = null;

export function getVaultSyncService(): VaultSyncService | null {
  return instance;
}

export async function initializeVaultSyncService(opts?: {
  gatewayPort?: number;
}): Promise<VaultSyncService> {
  if (instance) return instance;
  instance = new VaultSyncService(opts);
  await instance.initialize();
  return instance;
}
