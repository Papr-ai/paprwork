#!/usr/bin/env node
/**
 * Run provenance schema drift probe using Papr Work.app for keychain decrypt.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const PAPR_WORK_BIN =
  process.env.PAPR_WORK_BIN?.trim() ??
  "/Applications/Papr Work.app/Contents/MacOS/Papr Work";

if (!existsSync(PAPR_WORK_BIN)) {
  console.error(`Papr Work binary not found: ${PAPR_WORK_BIN}`);
  process.exit(1);
}

const child = spawnSync(
  PAPR_WORK_BIN,
  [path.join(root, "scripts/run-probe-provenance-schema-diff-inner.mjs")],
  { cwd: root, env: process.env, stdio: "inherit" },
);
process.exit(child.status ?? 1);
