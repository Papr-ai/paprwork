#!/usr/bin/env node
/**
 * Write build/packaged-gateway-env.json for electron-builder extraResources.
 * Release CI passes secrets via env; local builds keep {} (dev uses .env.local).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const outPath = resolve(process.cwd(), "build/packaged-gateway-env.json");

const keys = [
  "PAPR_CLOUD_APP_HOST_KEY",
  "PAPR_APP_REPO_WRITER_URL",
  "PAPR_MEMORY_SERVER_URL",
] as const;

const payload = {};
for (const key of keys) {
  const value = process.env[key]?.trim();
  if (value) {
    payload[key] = value;
  }
}

mkdirSync(resolve(process.cwd(), "build"), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

const included = Object.keys(payload);
console.log(
  `[packaged-gateway-env] Wrote ${outPath} (${included.length} key(s): ${included.join(", ") || "none"})`,
);
