#!/usr/bin/env node
/**
 * Build the Neural Engine helper (native/papr-embed-coreml) on macOS.
 *   node scripts/build-coreml-helper.mjs            dev: skip when up to date; warn (do not fail) if swiftc is missing
 *   node scripts/build-coreml-helper.mjs --strict   release: always build and fail the build if it cannot
 * Without the helper, Apple Silicon Macs fall back to ONNX on the CPU (~4 cores while indexing).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const strict = process.argv.includes("--strict");
if (process.platform !== "darwin") process.exit(0);
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "native", "papr-embed-coreml");
const out = path.join(dir, "build", "papr-embed-coreml");
const src = path.join(dir, "main.swift");
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
if (!strict && mtime(out) > mtime(src)) process.exit(0);
try {
  execFileSync("sh", [path.join(dir, "build.sh")], { stdio: "inherit" });
  if (!fs.existsSync(out)) throw new Error(`${out} was not produced`);
  console.log(`[coreml] built ${out}`);
} catch (e) {
  const msg = `[coreml] could not build the Neural Engine helper (${e instanceof Error ? e.message : e}). Install Xcode Command Line Tools (xcode-select --install). Code search will use ONNX on the CPU.`;
  if (strict) { console.error(msg); process.exit(1); }
  console.warn(msg);
}
