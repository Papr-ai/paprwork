import { traceDiagnosticPhase } from "../../core/utils/performanceDiagnostics.js";
/**
 * Vault Sync Service — syncs local custom keys (macOS Keychain) to cloud vault
 * (GCP Secret Manager) via the memory server.
 *
 * Flow:
 *   1. On init: push local keys that changed since last successful sync
 *   2. On init: pull user-scoped vault key names for cross-device awareness (names only)
 *   3. On key change: push updated keys → cloud vault
 *
 * Pull uses scope=user only (acting user via external_user_id). Cloud app host
 * uses scope=context for ACL union. Canonical vault: one secret per key name.
 *
 * The cloud proxy at /api/cloud/vault/* forwards to /v1/cloud/vault/*
 * on the memory server, attaching the user's PAPR_API_KEY automatically.
 */

import {
  buildCloudVaultRequestBody,
  mapCustomKeyMetadataToVaultEntry,
  resolveActiveNamespaceId,
} from "../../core/utils/cloudReposScope.js";
import {
  mapCloudVaultPermission,
  shouldPushKeyToCloud,
  type SharedVaultKeyInput,
} from "../../core/storage/sharedVaultMirror.js";
import type { CloudRepoScope, CloudVaultKeyEntry } from "../../core/utils/cloudReposScope.js";
import type { IntegrationKeyVaultAudience } from "../../core/storage/customKeysVault.js";
import { getCustomKeysService } from "./CustomKeysService.js";
import { resolveVaultKeySource } from "./cloudAgentGateway/resolveCloudProviderAuth.js";
import {
  isPaprCloudPaused,
  isPaprSubscriptionBlockedMessage,
  reportPaprQuotaError,
} from "../../core/utils/paprQuota.js";
import { getPaprApiKey } from "../utils/keyResolver.js";
import { waitForGatewayRoutesReady } from "./gatewayReadiness.js";

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT ?? "18789", 10);
const GATEWAY_ROUTES_WAIT_MS = 120_000;
const PUSH_TIMEOUT_MS = 120_000; // 52 keys × ~2s each on GCP Secret Manager
const PULL_TIMEOUT_MS = 15_000;
const PULL_SHARED_TIMEOUT_MS = 60_000; // returns values — can be slow with many org keys

interface VaultKeyInfo {
  name: string;
  syncedAt: string;
}

interface VaultShareConflict {
  name: string;
  reason?: string;
  ownerUserId?: string;
  shareScope?: string;
}

interface VaultSyncResponse {
  synced: number;
  created: string[];
  updated: string[];
  unchanged?: string[];
  deleted: string[];
  conflicts?: VaultShareConflict[];
}

interface VaultListKeysResponse {
  keys: VaultKeyInfo[];
}

interface VaultPullSharedKeyResponse {
  name: string;
  value: string;
  shareScope: "namespace" | "org";
  syncedAt?: string;
  permission?: string;
  clientAccess?: "server" | "client";
  source?: string;
  ownerUserId?: string;
}

interface VaultPullSharedResponse {
  keys: VaultPullSharedKeyResponse[];
}

interface VaultDeleteResponse {
  deleted: string[];
  not_found: string[];
}

export interface SyncKeyVaultChangeInput {
  name: string;
  previousAudience?: IntegrationKeyVaultAudience | null;
  nextAudience?: IntegrationKeyVaultAudience | null;
  targetOrgId?: string;
  mode: "delete" | "update";
}

export interface SyncKeyVaultChangeResult {
  deleted: string[];
  notFound: string[];
  push: VaultSyncResponse | null;
}

type VaultSyncStatus = "idle" | "syncing" | "error" | "disabled";

interface VaultState {
  status: VaultSyncStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  keyCount: number;
}

const VAULT_PUSH_DEBOUNCE_MS = 2_000;

export class VaultSyncService {
  private state: VaultState = {
    status: "idle",
    lastSyncAt: null,
    lastError: null,
    keyCount: 0,
  };

  private pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pushInFlight: Promise<VaultSyncResponse | null> | null = null;
  private pushPendingAfterInflight = false;
  private fullSyncInFlight: Promise<VaultSyncResponse | null> | null = null;
  private fullSyncRerunPending = false;
  private initializeInFlight: Promise<void> | null = null;

  private readonly gatewayPort: number;

  constructor(opts?: { gatewayPort?: number }) {
    this.gatewayPort = opts?.gatewayPort ?? GATEWAY_PORT;
  }

  getState(): VaultState {
    return { ...this.state };
  }

  /** True while startup init or a coalesced full sync / push is in flight. */
  isSyncBusy(): boolean {
    return (
      this.initializeInFlight !== null ||
      this.fullSyncInFlight !== null ||
      this.pushInFlight !== null
    );
  }

  /**
   * Initialize: push local keys to cloud, then pull to discover cross-device keys.
   */
  async initialize(): Promise<void> {
    if (this.initializeInFlight) {
      await this.initializeInFlight;
      return;
    }

    this.initializeInFlight = this.initializeOnce();
    try {
      await this.initializeInFlight;
    } finally {
      this.initializeInFlight = null;
    }
  }

  private async initializeOnce(): Promise<void> {
    console.log("[VaultSync] Initializing...");

    const paprKey = await getPaprApiKey();
    if (!paprKey) {
      console.warn("[VaultSync] No PAPR_API_KEY — vault sync disabled");
      this.state.status = "disabled";
      return;
    }

    try {
      const pushed = await this.runFullSync();
      if (!pushed) {
        // Gateway may start before Electron IPC is ready; retry once keys are readable.
        setTimeout(() => {
          void this.enqueuePush().then((retry) => {
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
   * Push → pull user key names → pull shared mirrors (coalesced).
   * Use on init and workspace switch so overlapping callers share one run.
   */
  async runFullSync(): Promise<VaultSyncResponse | null> {
    if (this.fullSyncInFlight) {
      this.fullSyncRerunPending = true;
      return this.fullSyncInFlight;
    }

    this.fullSyncInFlight = traceDiagnosticPhase("vault:full-sync", () => this.runFullSyncOnce());
    try {
      return await this.fullSyncInFlight;
    } finally {
      this.fullSyncInFlight = null;
      if (this.fullSyncRerunPending) {
        this.fullSyncRerunPending = false;
        return this.runFullSync();
      }
    }
  }

  private async runFullSyncOnce(): Promise<VaultSyncResponse | null> {
    const { yieldToInteractiveHotPath } = await import(
      "./gatewayBackgroundWork.js"
    );
    await yieldToInteractiveHotPath("VaultSync.runFullSync");
    const pushed = await traceDiagnosticPhase("vault:push", () => this.enqueuePush());
    await traceDiagnosticPhase("vault:pull-key-names", () => this.pullKeys());
    await traceDiagnosticPhase("vault:pull-shared-keys", () => this.pullSharedKeys());
    return pushed;
  }

  private async ensureGatewayRoutesReady(): Promise<void> {
    await traceDiagnosticPhase("vault:wait-for-routes", async () => {
      const ready = await waitForGatewayRoutesReady(GATEWAY_ROUTES_WAIT_MS);
      if (!ready) throw Object.assign(new Error("Gateway routes not ready"), { name: "TimeoutError" });
    }, true);
  }

  /**
   * Push all local custom keys to the cloud vault (coalesced — concurrent calls share one push).
   */
  async pushAllKeys(): Promise<VaultSyncResponse | null> {
    return this.enqueuePush();
  }

  private async enqueuePush(): Promise<VaultSyncResponse | null> {
    if (this.pushInFlight) {
      this.pushPendingAfterInflight = true;
      return this.pushInFlight;
    }

    this.pushInFlight = this.pushAllKeysUncoalesced();
    try {
      return await this.pushInFlight;
    } finally {
      const rerun = this.pushPendingAfterInflight;
      this.pushPendingAfterInflight = false;
      this.pushInFlight = null;
      if (rerun) {
        return this.enqueuePush();
      }
    }
  }

  /**
   * Debounced full push after list-wide cache invalidation (IPC / workspace switch).
   */
  scheduleDebouncedPushAll(): void {
    this.schedulePushAfterKeyChange("(all keys)", "changed");
  }

  /** Build vault push payload on gateway (keychain IPC stays in parent). */
  async buildVaultPushEntriesForBackground(): Promise<CloudVaultKeyEntry[]> {
    if (isPaprCloudPaused()) {
      return [];
    }

    const customKeys = getCustomKeysService();
    const keyList = await customKeys.listKeys();
    if (keyList.length === 0) {
      this.state.keyCount = 0;
      return [];
    }

    const vaultEntries: CloudVaultKeyEntry[] = [];

    for (const meta of keyList) {
      if (meta.scope === "global") {
        continue;
      }
      if (!shouldPushKeyToCloud(meta)) {
        continue;
      }
      try {
        const value = await customKeys.getKeyByName(meta.name);
        if (!value) {
          continue;
        }
        vaultEntries.push(
          mapCustomKeyMetadataToVaultEntry({
            meta: {
              name: meta.name,
              permission: meta.permission,
              clientAccess: meta.clientAccess,
              vaultAudience: meta.vaultAudience,
              vaultAudienceMemberIds: meta.vaultAudienceMemberIds,
              orgScope: meta.orgScope,
              organizationId: meta.organizationId,
              source: meta.source,
              managedBy: meta.managedBy,
              oauthProvider: meta.oauthProvider,
              description: meta.description,
            },
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

    return vaultEntries;
  }

  async applyVaultPushResultFromBackground(
    result: VaultSyncResponse,
  ): Promise<void> {
    this.state.status = "idle";
    this.state.lastSyncAt = new Date().toISOString();
    this.state.lastError = null;
    this.state.keyCount = result.synced;

    const customKeys = getCustomKeysService();
    await customKeys.reconcileShareSyncResult({
      conflicts: result.conflicts ?? [],
      syncedNames: [...result.created, ...result.updated],
    });

    if (result.conflicts && result.conflicts.length > 0) {
      console.warn(
        `[VaultSync] ${result.conflicts.length} key(s) not shared — name already taken in cloud vault`,
      );
    }

    console.log(
      `[VaultSync] Pushed ${result.synced} keys (${result.created.length} created, ${result.updated.length} updated${result.unchanged?.length ? `, ${result.unchanged.length} unchanged on server` : ""})`,
    );
  }

  private async pushAllKeysUncoalesced(): Promise<VaultSyncResponse | null> {
    const { yieldToInteractiveHotPath } = await import(
      "./gatewayBackgroundWork.js"
    );
    await yieldToInteractiveHotPath("VaultSync.pushAll");
    if (isPaprCloudPaused()) {
      console.log(
        "[VaultSync] Skipping push — Papr Cloud paused (no active subscription)",
      );
      return null;
    }

    const vaultEntries = await traceDiagnosticPhase("vault:prepare-keys", () => this.buildVaultPushEntriesForBackground());
    if (vaultEntries.length === 0) {
      console.log("[VaultSync] No readable key values to push");
      return null;
    }

    const { filterVaultEntriesNeedingPush, markVaultPushFingerprints } =
      await import("../utils/vaultPushStateStore.js");
    const { toPush, skippedNames } = filterVaultEntriesNeedingPush(vaultEntries);
    if (skippedNames.length > 0) {
      console.log(
        `[VaultSync] Skipping ${skippedNames.length} unchanged key(s) locally (fingerprint match)`,
      );
    }
    if (toPush.length === 0) {
      console.log("[VaultSync] All keys match last push — skipping cloud sync");
      this.state.status = "idle";
      this.state.lastSyncAt = new Date().toISOString();
      this.state.keyCount = vaultEntries.length;
      return {
        synced: 0,
        created: [],
        updated: [],
        unchanged: skippedNames,
        deleted: [],
        conflicts: [],
      };
    }

    this.state.status = "syncing";
    this.state.keyCount = vaultEntries.length;
    console.log(
      `[VaultSync] Pushing ${toPush.length}/${vaultEntries.length} keys to vault (per-key shareScope)...`,
    );

    try {
      await this.ensureGatewayRoutesReady();
      const { pushVaultEntriesViaGatewayHttp } = await import(
        "./vaultSyncBackgroundPush.js"
      );
      const result = await traceDiagnosticPhase("vault:push-http", () => pushVaultEntriesViaGatewayHttp(
        this.gatewayPort,
        toPush,
      ));
      if (!result) {
        this.state.status = "idle";
        return null;
      }
      markVaultPushFingerprints(toPush);
      await traceDiagnosticPhase("vault:apply-push-result", () => this.applyVaultPushResultFromBackground(result));
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      if (isPaprSubscriptionBlockedMessage(msg)) {
        reportPaprQuotaError(err, "vault-sync");
        console.warn(
          "[VaultSync] Push paused — Papr Cloud subscription inactive",
        );
        return null;
      }
      this.state.status = "error";
      this.state.lastError = msg;
      console.error("[VaultSync] Push failed:", msg);
      return null;
    }
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

    const data = await traceDiagnosticPhase("vault:pull-names-http", async () => {
      const resp = await fetch(`http://localhost:${this.gatewayPort}/api/cloud/vault/keys?${params}`, { signal });
      if (!resp.ok) throw Object.assign(new Error(`Vault names request failed (${resp.status})`), { status: resp.status });
      return await resp.json() as VaultListKeysResponse;
    });

    return data.keys.map((k) => k.name);
  }

  /**
   * Pull user-scoped vault key names for cross-device awareness.
   * Values are NOT pulled (list endpoint has no values). Names are never
   * written to the local keychain from this path.
   */
  async pullKeys(): Promise<string[]> {
    if (isPaprCloudPaused()) {
      return [];
    }

    try {
      await this.ensureGatewayRoutesReady();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);

      const userScopedNames = await this.fetchVaultKeyNamesForScope(
        "user", controller.signal,
      ).finally(() => clearTimeout(timer));

      const customKeys = getCustomKeysService();
      const localKeys = await customKeys.listKeys();
      const localNames = new Set(localKeys.map((k) => k.name));

      const missingLocally = userScopedNames.filter((n) => !localNames.has(n));

      if (missingLocally.length > 0) {
        console.log(
          `[VaultSync] ${missingLocally.length} user-scoped vault key(s) exist in cloud but not locally (names omitted from logs)`,
        );
        // We log but don't auto-add — values aren't available from list endpoint.
      }

      return userScopedNames;
    } catch (err) {
      console.warn("[VaultSync] Pull failed:", (err as Error).message);
      return [];
    }
  }

  /**
   * Pull team/org shared keys into the local keychain (read-only mirrors).
   */
  async pullSharedKeys(): Promise<number> {
    if (isPaprCloudPaused()) {
      return 0;
    }

    const namespaceId = resolveActiveNamespaceId();
    if (!namespaceId) {
      console.log("[VaultSync] No active namespace — skipping shared vault pull");
      return 0;
    }

    try {
      await this.ensureGatewayRoutesReady();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PULL_SHARED_TIMEOUT_MS);

      const { mergeCloudActingUserBody } = await import(
        "../utils/cloudActingUser.js"
      );

      const data = await traceDiagnosticPhase("vault:pull-shared-http", async () => {
        try {
          const resp = await fetch(
            `http://localhost:${this.gatewayPort}/api/cloud/vault/pull-shared`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(mergeCloudActingUserBody({ namespaceId })),
              signal: controller.signal,
            },
          );
          if (!resp.ok) throw Object.assign(new Error(`Vault shared request failed (${resp.status})`), { status: resp.status });
          return await resp.json() as VaultPullSharedResponse;
        } finally { clearTimeout(timer); }
      });

      const mirrors: SharedVaultKeyInput[] = (data.keys ?? []).map((key) => ({
        name: key.name,
        value: key.value,
        permission: mapCloudVaultPermission(key.permission),
        clientAccess: key.clientAccess ?? "server",
        vaultAudience: key.shareScope,
        sharedOwnerUserId: key.ownerUserId,
        sharedSyncedAt: key.syncedAt,
        source: key.source === "oauth" ? "oauth" : "manual",
      }));

      const customKeys = getCustomKeysService();
      const result = await traceDiagnosticPhase("vault:apply-shared-mirrors", () => customKeys.syncSharedMirrors(mirrors));
      if (result.upserted > 0 || result.pruned > 0) {
        console.log(
          `[VaultSync] Shared mirrors updated (upserted=${result.upserted}, pruned=${result.pruned})`,
        );
      }
      return result.upserted;
    } catch (err) {
      console.warn("[VaultSync] Shared pull failed:", (err as Error).message);
      return 0;
    }
  }

  /**
   * Delete one canonical vault secret (and any legacy path copies) by key name.
   */
  async deleteKeyByName(
    name: string,
    targetOrgId?: string,
  ): Promise<VaultDeleteResponse> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return { deleted: [], not_found: [] };
    }

    const namespaceId = resolveActiveNamespaceId();
    const { mergeCloudActingUserBody } = await import(
      "../utils/cloudActingUser.js"
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

    try {
      await this.ensureGatewayRoutesReady();

      const resp = await fetch(
        `http://localhost:${this.gatewayPort}/api/cloud/vault/delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            mergeCloudActingUserBody({
              ...(namespaceId ? { namespaceId } : {}),
              keys: [
                {
                  name: trimmedName,
                  ...(targetOrgId?.trim()
                    ? { targetOrgId: targetOrgId.trim() }
                    : {}),
                },
              ],
            }),
          ),
          signal: controller.signal,
        },
      );

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Vault delete failed (${resp.status}): ${text.slice(0, 200)}`);
      }

      const result = (await resp.json()) as VaultDeleteResponse;
      if (result.deleted.length > 0) {
        const { forgetVaultPushFingerprint } = await import(
          "../utils/vaultPushStateStore.js"
        );
        forgetVaultPushFingerprint(trimmedName);
        console.log(
          `[VaultSync] Deleted cloud vault key "${trimmedName}" (canonical + legacy cleanup)`,
        );
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Owner delete or audience change: delete canonical secret or re-push labels/value.
   */
  async syncKeyVaultChange(
    input: SyncKeyVaultChangeInput,
  ): Promise<SyncKeyVaultChangeResult> {
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      return { deleted: [], notFound: [], push: null };
    }

    let deleteResult: VaultDeleteResponse = { deleted: [], not_found: [] };
    if (input.mode === "delete") {
      deleteResult = await this.deleteKeyByName(trimmedName, input.targetOrgId);
    }

    let push: VaultSyncResponse | null = null;
    if (input.mode === "update") {
      push = await this.enqueuePush();
    }

    return {
      deleted: deleteResult.deleted,
      notFound: deleteResult.not_found,
      push,
    };
  }

  /** Push + pull after org/namespace workspace switch (non-blocking). */
  syncForWorkspaceSwitch(): void {
    console.log("[VaultSync] Re-syncing vault for workspace switch (background)...");
    void import("./gatewayBackgroundWork.js").then(({ scheduleCoalescedBackgroundWork }) => {
      scheduleCoalescedBackgroundWork("vault:workspace-switch", async () => {
        await this.runFullSync();
      });
    });
  }

  /**
   * Coalesce rapid key changes (e.g. LinkedIn cookie refresh delete+add pairs)
   * into one vault push after a short debounce window.
   */
  schedulePushAfterKeyChange(keyName: string, kind: "changed" | "deleted"): void {
    console.log(
      `[VaultSync] Key ${kind}: ${keyName} — scheduling vault sync (${VAULT_PUSH_DEBOUNCE_MS}ms debounce)`,
    );
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
    }
    this.pushDebounceTimer = setTimeout(() => {
      this.pushDebounceTimer = null;
      void this.flushScheduledPush();
    }, VAULT_PUSH_DEBOUNCE_MS);
  }

  private async flushScheduledPush(): Promise<void> {
    await this.enqueuePush();
  }

  /**
   * Notify that a key was added or updated. Triggers a debounced full push.
   */
  async onKeyChanged(keyName: string): Promise<void> {
    this.schedulePushAfterKeyChange(keyName, "changed");
  }

  /**
   * Notify that a key was deleted locally — remove the canonical cloud secret.
   */
  async onKeyDeleted(
    keyName: string,
    opts?: { targetOrgId?: string },
  ): Promise<void> {
    await this.syncKeyVaultChange({
      name: keyName,
      mode: "delete",
      targetOrgId: opts?.targetOrgId,
    });
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
