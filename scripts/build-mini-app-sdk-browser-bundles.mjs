#!/usr/bin/env node
/**
 * Pre-bundle every mini-app SDK module for packaged builds.
 *
 * Runtime esbuild needs .ts sources on disk inside app.asar.unpacked; auto-update
 * deltas can omit them, leaving only sdk-manifest.js + papr-auth-ui.js. Prebuilt
 * bundles in bundled/ let the gateway serve static JS with no on-demand compile.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SDK_DIR = path.join(ROOT, "dist/resources/mini-app-sdk");
const OUT_DIR = path.join(SDK_DIR, "bundled");
const MANIFEST_PATH = path.join(SDK_DIR, "sdk-manifest.js");

async function main() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(
      `[mini-app-sdk] Missing ${MANIFEST_PATH} — run tsc -p tsconfig.mini-app-sdk-node.json first`,
    );
    process.exit(1);
  }

  const { MINI_APP_SDK_MODULES } = await import(
    pathToFileURL(MANIFEST_PATH).href
  );

  const esbuild = await import("esbuild");
  mkdirSync(OUT_DIR, { recursive: true });

  let failed = false;
  for (const mod of MINI_APP_SDK_MODULES) {
    const entry = path.join(SDK_DIR, mod.file);
    const outName = mod.file.replace(/\.ts$/, ".js");
    const outFile = path.join(OUT_DIR, outName);

    if (!existsSync(entry)) {
      console.error(`[mini-app-sdk] Missing source for ${mod.route}: ${entry}`);
      failed = true;
      continue;
    }

    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: mod.format === "iife" ? "iife" : "esm",
      platform: "browser",
      target: "es2020",
      write: false,
      sourcemap: "inline",
    });

    const code = result.outputFiles?.[0]?.text;
    if (!code) {
      console.error(`[mini-app-sdk] Empty bundle for ${mod.route}`);
      failed = true;
      continue;
    }

    writeFileSync(outFile, code, "utf8");
    console.log(`[mini-app-sdk] ✓ ${mod.route} → bundled/${outName}`);
  }

  if (failed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[mini-app-sdk] bundle build failed:", err);
  process.exit(1);
});
