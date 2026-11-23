import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const userData = await fs.mkdtemp(path.join(os.tmpdir(), "papr-keys-share-"));

vi.mock("electron", () => {
  const m = {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    },
  };
  return { ...m, default: m };
});

const { CustomKeysStorage } = await import("../../src/core/storage/CustomKeysStorage.js");

afterAll(async () => {
  await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("CustomKeysStorage share conflicts", () => {
  // Repro: AMPLITUDE_API_KEY saved for "all my orgs" + shared with the org. The cloud
  // refused it (name_taken) but the key showed as shared, because conflicts were only
  // recorded for keys in the active org's file.
  it("marks an all-orgs key 'Not shared' when the cloud refuses it, and clears it after", async () => {
    const store = new CustomKeysStorage();
    await store.initialize();
    await store.setActiveOrganization("org-a");
    await store.addKey({
      name: "AMPLITUDE_API_KEY",
      value: "v",
      orgScope: "all",
      vaultAudience: "org",
    });

    await store.reconcileShareSyncResult({
      conflicts: [{ name: "AMPLITUDE_API_KEY", reason: "name_taken", ownerUserId: "amir" }],
      syncedNames: [],
    });
    let meta = (await store.listKeys()).find((k) => k.name === "AMPLITUDE_API_KEY");
    expect(meta?.scope).toBe("shared");
    expect(meta?.vaultShareBlocked).toBe(true);
    expect(meta?.vaultShareBlockedOwnerUserId).toBe("amir");

    // Survives a restart (persisted to the shared file, not just memory).
    const reopened = new CustomKeysStorage();
    await reopened.initialize();
    await reopened.setActiveOrganization("org-a");
    meta = (await reopened.listKeys()).find((k) => k.name === "AMPLITUDE_API_KEY");
    expect(meta?.vaultShareBlocked).toBe(true);

    await reopened.reconcileShareSyncResult({ conflicts: [], syncedNames: ["AMPLITUDE_API_KEY"] });
    meta = (await reopened.listKeys()).find((k) => k.name === "AMPLITUDE_API_KEY");
    expect(meta?.vaultShareBlocked).toBeUndefined();
  });
});
