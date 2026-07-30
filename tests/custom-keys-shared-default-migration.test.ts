import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CustomKey } from "../src/core/storage/CustomKeysStorage.js";
import {
  migrateIntegrationKeysToSharedDefault,
  INTEGRATION_KEYS_SHARED_DEFAULT_MARKER,
} from "../src/core/storage/customKeysSharedDefaultMigration.js";
import { SHARED_ORG_ID } from "../src/core/storage/customKeysVault.js";

function makeKey(id: string, name: string, updatedAt: string): CustomKey {
  return {
    id,
    name,
    permission: "always",
    clientAccess: "server",
    encryptedValue: "encrypted",
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("migrateIntegrationKeysToSharedDefault", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("promotes integration keys from org vaults into shared and is idempotent", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-keys-"));
    const orgAPath = path.join(tempDir, "orgs", "org-a", "custom-keys.json");
    const sharedPath = path.join(tempDir, "orgs", SHARED_ORG_ID, "custom-keys.json");

    await fs.mkdir(path.dirname(orgAPath), { recursive: true });
    await fs.writeFile(
      orgAPath,
      JSON.stringify({
        k1: makeKey("k1", "OPENAI_API_KEY", "2026-01-01T00:00:00.000Z"),
        k2: makeKey("k2", "NEON_DB_URL", "2026-02-01T00:00:00.000Z"),
      }),
      "utf-8",
    );

    const first = await migrateIntegrationKeysToSharedDefault(tempDir);
    expect(first.ran).toBe(true);
    expect(first.promotedKeyCount).toBe(2);
    expect(first.sourceOrganizations).toEqual(["org-a"]);

    const sharedRaw = JSON.parse(await fs.readFile(sharedPath, "utf-8")) as Record<
      string,
      CustomKey
    >;
    expect(Object.keys(sharedRaw)).toHaveLength(2);

    const orgRaw = JSON.parse(await fs.readFile(orgAPath, "utf-8")) as Record<
      string,
      CustomKey
    >;
    expect(Object.keys(orgRaw)).toHaveLength(0);

    const second = await migrateIntegrationKeysToSharedDefault(tempDir);
    expect(second.ran).toBe(false);

    await fs.access(path.join(tempDir, INTEGRATION_KEYS_SHARED_DEFAULT_MARKER));
  });
});
