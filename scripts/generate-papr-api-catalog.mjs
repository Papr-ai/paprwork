#!/usr/bin/env node
/**
 * Generates src/resources/papr-api-catalog.json from code (HTTP entries, SDK, agent tools).
 */
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const catalogModuleUrl = pathToFileURL(
  path.join(root, "src/core/paprApiCatalog/buildCatalog.ts"),
).href;
const { buildPaprApiCatalog } = await import(catalogModuleUrl);

const catalog = buildPaprApiCatalog();
const outDir = path.join(root, "src/resources");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "papr-api-catalog.json");
writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(`[papr-api-catalog] Wrote ${catalog.entryCount} entries → ${outPath}`);
