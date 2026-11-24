import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { computeVaultPushFingerprint } from "../../../src/gateway/utils/vaultPushFingerprint.js";
import {
  filterVaultEntriesNeedingPush,
  markVaultPushFingerprints,
  forgetVaultPushFingerprint,
} from "../../../src/gateway/utils/vaultPushStateStore.js";
import type { CloudVaultKeyEntry } from "../../../src/core/utils/cloudReposScope.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

describe("computeVaultPushFingerprint", () => {
  it("changes when value changes", () => {
    const base: CloudVaultKeyEntry = { name: "K", value: "a" };
    const other: CloudVaultKeyEntry = { name: "K", value: "b" };
    expect(computeVaultPushFingerprint(base)).not.toBe(
      computeVaultPushFingerprint(other),
    );
  });

  it("is stable for allowedUserIds order", () => {
    const a: CloudVaultKeyEntry = {
      name: "K",
      value: "v",
      shareScope: "members",
      allowedUserIds: ["b", "a"],
    };
    const b: CloudVaultKeyEntry = {
      name: "K",
      value: "v",
      shareScope: "members",
      allowedUserIds: ["a", "b"],
    };
    expect(computeVaultPushFingerprint(a)).toBe(computeVaultPushFingerprint(b));
  });
});

describe("vaultPushStateStore", () => {
  const statePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "vault-push-state-")),
    "vault-push-fingerprints.json",
  );
  const priorEnv = process.env.PAPR_VAULT_PUSH_STATE_PATH;

  beforeEach(() => {
    process.env.PAPR_VAULT_PUSH_STATE_PATH = statePath;
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  });

  afterEach(() => {
    if (priorEnv === undefined) {
      delete process.env.PAPR_VAULT_PUSH_STATE_PATH;
    } else {
      process.env.PAPR_VAULT_PUSH_STATE_PATH = priorEnv;
    }
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  });

  const entry: CloudVaultKeyEntry = { name: "API_KEY", value: "secret" };

  it("filters unchanged entries after mark", () => {
    markVaultPushFingerprints([entry]);
    const { toPush, skippedNames } = filterVaultEntriesNeedingPush([entry]);
    expect(toPush).toHaveLength(0);
    expect(skippedNames).toEqual(["API_KEY"]);
  });

  it("forget clears fingerprint so entry pushes again", () => {
    markVaultPushFingerprints([entry]);
    forgetVaultPushFingerprint("API_KEY");
    const { toPush } = filterVaultEntriesNeedingPush([entry]);
    expect(toPush).toHaveLength(1);
  });
});

describe("refused pushes are retried", () => {
  it("does not fingerprint keys the server answered with a conflict", () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/VaultSyncService.ts"),
      "utf-8",
    );
    // Regression: AMPLITUDE_* was refused (name_taken) yet fingerprinted, so it was
    // never pushed again — teammates never received the org-shared key.
    expect(content).toMatch(/refused\.has\(entry\.name/);
    expect(content).not.toMatch(/markVaultPushFingerprints\(toPush\);/);
  });

  it("fingerprint format is versioned so stale refused fingerprints re-push once", () => {
    const entry: CloudVaultKeyEntry = { name: "AMPLITUDE_API_KEY", value: "v", shareScope: "org" };
    const legacy = createHash("sha256")
      .update(
        JSON.stringify({
          name: entry.name,
          value: entry.value,
          source: "",
          clientAccess: "server",
          shareScope: "org",
          targetOrgId: "",
          permission: "always_allow",
          allowedUserIds: [],
          penAccess: "",
        }),
      )
      .digest("hex");
    expect(computeVaultPushFingerprint(entry)).not.toBe(legacy);
  });
});
