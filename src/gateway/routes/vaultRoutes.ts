/**
 * Vault sync HTTP routes and the key-change → vault push wiring.
 * Extracted from gateway/index.ts so both can be tested without booting the gateway.
 */
import type { Express } from "express";
import type { VaultSyncService } from "../services/VaultSyncService.js";

type VaultLookup = () => Pick<
  VaultSyncService,
  "getState" | "pushAllKeys" | "pullSharedKeys" | "syncKeyVaultChange"
> | null;

export function registerVaultRoutes(app: Express, getVault: VaultLookup): void {
  app.get("/api/vault/status", (_req, res) => {
    const vault = getVault();
    if (!vault) {
      res.json({ enabled: false, reason: "Vault sync not initialized" });
      return;
    }
    res.json({ enabled: true, ...vault.getState() });
  });

  app.post("/api/vault/push", async (_req, res) => {
    const vault = getVault();
    if (!vault) {
      res.status(503).json({ error: "Vault sync not initialized" });
      return;
    }
    try {
      const result = await vault.pushAllKeys();
      res.json({ success: true, ...vault.getState(), result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/vault/pull-shared", async (_req, res) => {
    const vault = getVault();
    if (!vault) {
      res.status(503).json({ error: "Vault sync not initialized" });
      return;
    }
    try {
      const upserted = await vault.pullSharedKeys();
      res.json({ success: true, ...vault.getState(), upserted });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/vault/sync-key", async (req, res) => {
    const vault = getVault();
    if (!vault) {
      res.status(503).json({ error: "Vault sync not initialized" });
      return;
    }
    const body = req.body as {
      name?: string;
      previousAudience?: string;
      nextAudience?: string;
      targetOrgId?: string;
      mode?: "delete" | "update";
    };
    if (
      !body.name?.trim() ||
      (body.mode !== "delete" && body.mode !== "update")
    ) {
      res
        .status(400)
        .json({ error: "name and mode (delete|update) are required" });
      return;
    }
    try {
      const result = await vault.syncKeyVaultChange({
        name: body.name.trim(),
        previousAudience: body.previousAudience as
          | import("../../core/storage/customKeysVault.js").IntegrationKeyVaultAudience
          | undefined,
        nextAudience: body.nextAudience as
          | import("../../core/storage/customKeysVault.js").IntegrationKeyVaultAudience
          | undefined,
        targetOrgId: body.targetOrgId,
        mode: body.mode,
      });
      res.json({ success: true, ...vault.getState(), result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}

/**
 * A named key change pushes that key; a bulk change (no name) schedules one
 * debounced full push. Push failures are logged, never thrown.
 */
export function wireVaultKeyChanges(
  keys: { onKeyChange(listener: (keyName?: string) => void): void },
  vault: Pick<VaultSyncService, "onKeyChanged" | "scheduleDebouncedPushAll">,
): void {
  keys.onKeyChange((keyName) => {
    if (keyName) {
      vault.onKeyChanged(keyName).catch((e) =>
        console.warn("[Gateway] Vault key push failed:", (e as Error).message),
      );
    } else {
      vault.scheduleDebouncedPushAll();
    }
  });
}
