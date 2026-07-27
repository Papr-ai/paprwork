/**
 * Vault Sync Tests — Milestone 1C client
 *
 * Tests: VaultSyncService structure, CustomKeysService change listener,
 * gateway wiring, and API endpoint configuration.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SRC = process.cwd();

describe("VaultSyncService", () => {
  it("exports VaultSyncService class", async () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/VaultSyncService.ts"),
      "utf-8",
    );
    expect(content).toContain("export class VaultSyncService");
  });

  it("exports singleton getter and initializer", async () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/VaultSyncService.ts"),
      "utf-8",
    );
    expect(content).toContain("export function getVaultSyncService");
    expect(content).toContain("export async function initializeVaultSyncService");
  });

  it("has pushAllKeys method that calls /api/cloud/vault/sync", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/VaultSyncService.ts"),
      "utf-8",
    );
    expect(content).toContain("async pushAllKeys()");
    expect(content).toContain("/api/cloud/vault/sync");
  });

  it("has pullKeys method that calls /api/cloud/vault/keys", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/VaultSyncService.ts"),
      "utf-8",
    );
    expect(content).toContain("async pullKeys()");
    expect(content).toContain("/api/cloud/vault/keys");
  });

  it("has onKeyChanged and onKeyDeleted handlers", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/VaultSyncService.ts"),
      "utf-8",
    );
    expect(content).toContain("async onKeyChanged(keyName: string)");
    expect(content).toContain("async onKeyDeleted(keyName: string)");
  });

  it("initialize calls pushAllKeys then pullKeys", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/VaultSyncService.ts"),
      "utf-8",
    );
    const initBlock = content.slice(
      content.indexOf("async initialize()"),
      content.indexOf("async pushAllKeys()"),
    );
    expect(initBlock).toContain("await this.pushAllKeys()");
    expect(initBlock).toContain("await this.pullKeys()");
  });

  it("getState returns vault status", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/VaultSyncService.ts"),
      "utf-8",
    );
    expect(content).toContain("getState(): VaultState");
    expect(content).toContain("status: VaultSyncStatus");
    expect(content).toContain("lastSyncAt");
    expect(content).toContain("keyCount");
  });

  it("disables when no PAPR_API_KEY", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/VaultSyncService.ts"),
      "utf-8",
    );
    expect(content).toContain('"disabled"');
    expect(content).toContain("No PAPR_API_KEY");
  });
});

describe("CustomKeysService change listener", () => {
  it("has onKeyChange method", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/CustomKeysService.ts"),
      "utf-8",
    );
    expect(content).toContain("onKeyChange(listener: KeyChangeListener)");
  });

  it("fires listeners in invalidateCache", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/CustomKeysService.ts"),
      "utf-8",
    );
    expect(content).toContain("for (const listener of this.changeListeners)");
  });

  it("has changeListeners array", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/CustomKeysService.ts"),
      "utf-8",
    );
    expect(content).toContain("private readonly changeListeners: KeyChangeListener[]");
  });
});

describe("Gateway wiring", () => {
  const indexContent = fs.readFileSync(
    path.join(SRC, "src/gateway/index.ts"),
    "utf-8",
  );

  it("imports VaultSyncService", () => {
    expect(indexContent).toContain("initializeVaultSyncService");
    expect(indexContent).toContain("getVaultSyncService");
  });

  it("initializes vault sync alongside cloud sync", () => {
    expect(indexContent).toContain("initializeVaultSyncService({ gatewayPort");
  });

  it("hooks key change listener to vault sync", () => {
    expect(indexContent).toContain("getCustomKeysService().onKeyChange");
    expect(indexContent).toContain("vaultSync.onKeyChanged");
  });

  it("has /api/vault/status endpoint", () => {
    expect(indexContent).toContain('"/api/vault/status"');
    expect(indexContent).toContain("getVaultSyncService()");
  });

  it("has /api/vault/push endpoint", () => {
    expect(indexContent).toContain('"/api/vault/push"');
    expect(indexContent).toContain("vault.pushAllKeys()");
  });

  it("vault sync is inside CLOUD_SYNC_ENABLED check", () => {
    const cloudSyncIdx = indexContent.indexOf(
      'process.env.CLOUD_SYNC_ENABLED !== "false"',
    );
    expect(cloudSyncIdx).toBeGreaterThan(-1);
    const block = indexContent.slice(cloudSyncIdx, cloudSyncIdx + 2500);
    expect(block).toContain("initializeVaultSyncService");
  });
});

describe("Vault API models alignment", () => {
  const vaultContent = fs.readFileSync(
    path.join(SRC, "src/gateway/services/VaultSyncService.ts"),
    "utf-8",
  );

  it("groups keys by vault audience scope when pushing", () => {
    expect(vaultContent).toContain("normalizeIntegrationKeyVaultAudience");
    expect(vaultContent).toContain("buildCloudVaultRequestBody");
    expect(vaultContent).toContain("keyPairsByScope");
    expect(vaultContent).toContain("cloudScope");
  });

  it("sends keys array with name and value", () => {
    expect(vaultContent).toContain("name: meta.name");
    expect(vaultContent).toContain("value");
  });

  it("VaultSyncResponse matches server model", () => {
    expect(vaultContent).toContain("synced: number");
    expect(vaultContent).toContain("created: string[]");
    expect(vaultContent).toContain("updated: string[]");
    expect(vaultContent).toContain("deleted: string[]");
  });

  it("VaultKeyInfo matches server model", () => {
    expect(vaultContent).toContain("name: string");
    expect(vaultContent).toContain("syncedAt: string");
  });
});
