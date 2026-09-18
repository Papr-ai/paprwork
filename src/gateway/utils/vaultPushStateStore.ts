/**
 * Per-workspace vault push fingerprints — skip HTTP when local key material unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import type { CloudVaultKeyEntry } from "../../core/utils/cloudReposScope.js";
import { readActiveWorkspacePointer } from "../../core/utils/paprWorkspace.js";
import { computeVaultPushFingerprint } from "./vaultPushFingerprint.js";

const STATE_FILENAME = "vault-push-fingerprints.json";

function resolveStatePath(): string | null {
  const override = process.env.PAPR_VAULT_PUSH_STATE_PATH?.trim();
  if (override) {
    return override;
  }
  const pointer = readActiveWorkspacePointer();
  if (!pointer?.userDataPath) {
    return null;
  }
  return path.join(pointer.userDataPath, STATE_FILENAME);
}

function readStateFile(): Record<string, string> {
  const statePath = resolveStatePath();
  if (!statePath || !fs.existsSync(statePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.length > 0) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStateFile(next: Record<string, string>): void {
  const statePath = resolveStatePath();
  if (!statePath) {
    return;
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2), "utf8");
}

export function filterVaultEntriesNeedingPush(entries: CloudVaultKeyEntry[]): {
  toPush: CloudVaultKeyEntry[];
  skippedNames: string[];
} {
  const prior = readStateFile();
  const toPush: CloudVaultKeyEntry[] = [];
  const skippedNames: string[] = [];

  for (const entry of entries) {
    const fingerprint = computeVaultPushFingerprint(entry);
    if (prior[entry.name] === fingerprint) {
      skippedNames.push(entry.name);
      continue;
    }
    toPush.push(entry);
  }

  return { toPush, skippedNames };
}

export function markVaultPushFingerprints(entries: CloudVaultKeyEntry[]): void {
  if (entries.length === 0) {
    return;
  }
  const prior = readStateFile();
  for (const entry of entries) {
    prior[entry.name] = computeVaultPushFingerprint(entry);
  }
  writeStateFile(prior);
}

export function forgetVaultPushFingerprint(keyName: string): void {
  const trimmed = keyName.trim();
  if (!trimmed) {
    return;
  }
  const prior = readStateFile();
  if (!(trimmed in prior)) {
    return;
  }
  delete prior[trimmed];
  writeStateFile(prior);
}
