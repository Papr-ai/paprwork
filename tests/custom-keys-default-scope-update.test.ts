import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const userData = await fs.mkdtemp(path.join(os.tmpdir(), "papr-keys-scope-"));

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

const { CustomKeysStorage } = await import("../src/core/storage/CustomKeysStorage.js");

afterAll(async () => {
  await fs.rm(userData, { recursive: true, force: true });
});

describe("CustomKeysStorage default-scope keys", () => {
  it("updates a key saved without orgScope instead of throwing (MCP sign-in saves twice)", async () => {
    const store = new CustomKeysStorage();
    await store.initialize();
    await store.setActiveOrganization("org-a");

    const input = { name: "MCP_LUCID_OAUTH", value: "{\"v\":1}", source: "oauth" as const, managedBy: "oauth" as const };
    await store.addKey(input);
    await expect(store.addKey({ ...input, value: "{\"v\":2}" })).resolves.toBeTruthy();
    expect(await store.getKeyByName("MCP_LUCID_OAUTH")).toBe("{\"v\":2}");
  });
});
