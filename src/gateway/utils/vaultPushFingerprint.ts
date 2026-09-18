/**
 * Fingerprint for vault push deduplication — matches fields sent to memory server.
 */

import { createHash } from "node:crypto";
import type { CloudVaultKeyEntry } from "../../core/utils/cloudReposScope.js";

export function computeVaultPushFingerprint(entry: CloudVaultKeyEntry): string {
  const payload = {
    name: entry.name,
    value: entry.value,
    source: entry.source ?? "",
    clientAccess: entry.clientAccess ?? "server",
    shareScope: entry.shareScope ?? "user",
    targetOrgId: entry.targetOrgId ?? "",
    permission: entry.permission ?? "always_allow",
    allowedUserIds: [...(entry.allowedUserIds ?? [])].sort(),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
