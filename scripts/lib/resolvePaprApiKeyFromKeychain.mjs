/**
 * Resolve PAPR_API_KEY from Papr Work keychain (Electron safeStorage).
 * Used by one-off maintenance scripts when plain node lacks IPC/keychain access.
 */
import fs from "node:fs";
import path from "node:path";
import electron from "electron";

const { app, safeStorage } = electron;

export async function resolvePaprApiKeyFromKeychain(options = {}) {
  if (process.env.PAPR_API_KEY?.trim()) {
    return process.env.PAPR_API_KEY.trim();
  }

  const orgId = options.orgId?.trim() ?? process.env.PAPR_ORG_ID?.trim() ?? "Y8D4H7Yp3Z";
  const namespaceId =
    options.namespaceId?.trim() ??
    process.env.PAPR_NAMESPACE_ID?.trim() ??
    "85ZIB7mD1V";

  await app.whenReady();
  const keysFile = path.join(
    app.getPath("userData"),
    "data",
    "orgs",
    orgId,
    "custom-keys.json",
  );
  const data = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  const entries = Object.values(data);
  const scopedName = namespaceId
    ? `PAPR_API_KEY__${namespaceId}`
    : "PAPR_API_KEY";
  const entry =
    entries.find((k) => k.name === scopedName) ??
    entries.find((k) => k.name === "PAPR_API_KEY");
  if (!entry?.encryptedValue) {
    throw new Error("PAPR_API_KEY not in keychain — login with Papr first");
  }
  return safeStorage.decryptString(Buffer.from(entry.encryptedValue, "base64"));
}
