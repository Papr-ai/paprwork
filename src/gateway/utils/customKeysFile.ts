import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { KeyClientAccess } from "../../core/types/customKeys.js";
import { normalizeKeyClientAccess } from "../../core/types/customKeys.js";

export interface CustomKeyFileMetadata {
  id: string;
  name: string;
  description?: string;
  permission: "always" | "ask";
  clientAccess?: KeyClientAccess;
  createdAt: string;
  updatedAt?: string;
}

interface StoredCustomKeyRecord {
  id: string;
  name: string;
  description?: string;
  permission?: "always" | "ask";
  clientAccess?: KeyClientAccess;
  createdAt: string;
  updatedAt?: string;
}

/** Papr Work userData path (matches Electron app.setName("Papr Work")). */
export function resolveCustomKeysJsonPath(): string {
  const home = os.homedir();

  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library/Application Support/Papr Work/data/custom-keys.json",
    );
  }

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Papr Work/data/custom-keys.json");
  }

  return path.join(home, ".config/Papr Work/data/custom-keys.json");
}

export async function loadCustomKeysMetadataFromFile(): Promise<
  CustomKeyFileMetadata[]
> {
  const keysFile = resolveCustomKeysJsonPath();

  try {
    const raw = await fs.readFile(keysFile, "utf8");
    const data = JSON.parse(raw) as Record<string, StoredCustomKeyRecord>;

    return Object.values(data).map((key) => ({
      id: key.id,
      name: key.name,
      description: key.description,
      permission: key.permission ?? "ask",
      clientAccess: normalizeKeyClientAccess(key.clientAccess),
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
    }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
