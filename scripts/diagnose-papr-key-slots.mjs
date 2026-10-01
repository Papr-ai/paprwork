#!/usr/bin/env node
/** Safe metadata only — never prints key material. */
import electron from "electron";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { app } = electron;

async function importDist(modulePath) {
  return import(pathToFileURL(join(process.cwd(), "dist", modulePath)).href);
}

async function main() {
  app.setName("Papr Work");
  await app.whenReady();

  const { CustomKeysStorage } = await importDist("core/storage/CustomKeysStorage.js");
  const { readActiveWorkspacePointer } = await importDist("core/utils/paprWorkspace.js");
  const { paprNamespaceApiKeyName, parsePaprApiKeyScope } = await importDist(
    "core/utils/paprApiKey.js",
  );

  const storage = new CustomKeysStorage();
  await storage.initialize();
  const pointer = readActiveWorkspacePointer();
  if (pointer?.organizationId) {
    await storage.setActiveOrganization(pointer.organizationId);
  }

  async function describe(name) {
    const value = await storage.getKeyByName(name);
    if (!value) {
      return { name, present: false };
    }
    const trimmed = value.trim();
    const usable = trimmed.startsWith("sk-") && Boolean(parsePaprApiKeyScope(trimmed));
    let shape = "other";
    if (trimmed.startsWith("sk-org-")) {
      shape = "sk-org-*";
    } else if (/^[0-9a-f]+$/i.test(trimmed)) {
      shape = "hex-only";
    }
    return {
      name,
      present: true,
      len: trimmed.length,
      shape,
      usable,
      namespaceInKey: usable ? parsePaprApiKeyScope(trimmed)?.namespaceId : null,
    };
  }

  const names = [
    pointer?.namespaceId ? paprNamespaceApiKeyName(pointer.namespaceId) : null,
    "PAPR_API_KEY",
    paprNamespaceApiKeyName("VIA2C5VDxj"),
  ].filter(Boolean);

  for (const name of names) {
    console.log(JSON.stringify(await describe(name)));
  }
  if (pointer) {
    console.log(
      JSON.stringify({
        activeWorkspace: {
          organizationId: pointer.organizationId,
          namespaceId: pointer.namespaceId,
        },
      }),
    );
  }

  app.quit();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit?.();
  process.exit(1);
});
