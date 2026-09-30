import { readFileSync, existsSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildPaprApiCatalog } from "./buildCatalog.js";
import type { PaprApiCatalog } from "./types.js";

let cached: PaprApiCatalog | null = null;
let cachedMtimeMs: number | null = null;

function resolveCatalogJsonPath(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  // dist/core/paprApiCatalog -> dist/resources/papr-api-catalog.json
  const fromDist = path.resolve(thisDir, "../../resources/papr-api-catalog.json");
  if (existsSync(fromDist)) {
    return fromDist;
  }
  // dev: src/core/paprApiCatalog -> src/resources/papr-api-catalog.json
  const fromSrc = path.resolve(thisDir, "../../resources/papr-api-catalog.json");
  if (existsSync(fromSrc)) {
    return fromSrc;
  }
  return fromDist;
}

function loadFromDisk(): PaprApiCatalog | null {
  const catalogPath = resolveCatalogJsonPath();
  if (!existsSync(catalogPath)) {
    return null;
  }
  try {
    const stat = statSync(catalogPath);
    if (cached && cachedMtimeMs === stat.mtimeMs) {
      return cached;
    }
    const raw = readFileSync(catalogPath, "utf8");
    const parsed = JSON.parse(raw) as PaprApiCatalog;
    if (!parsed.entries || !Array.isArray(parsed.entries)) {
      return null;
    }
    cached = parsed;
    cachedMtimeMs = stat.mtimeMs;
    return parsed;
  } catch {
    return null;
  }
}

/** Load catalog from generated JSON, or build in-memory if missing (dev). */
export function getPaprApiCatalog(): PaprApiCatalog {
  const fromDisk = loadFromDisk();
  if (fromDisk) {
    return fromDisk;
  }
  return buildPaprApiCatalog();
}

export function clearPaprApiCatalogCache(): void {
  cached = null;
  cachedMtimeMs = null;
}
