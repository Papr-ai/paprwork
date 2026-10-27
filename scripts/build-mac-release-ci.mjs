#!/usr/bin/env node
/**
 * Mac release build for GitHub Actions: run electron-builder and recover from
 * transient staple / CloudKit failures (common on macos-15-intel).
 *
 * Usage: node scripts/build-mac-release-ci.mjs --arm64|--x64
 */

import { spawnSync } from "node:child_process";
import { recoverFromStapleFailure } from "./macos-staple-retry.mjs";

const archFlag = process.argv[2];
if (archFlag !== "--arm64" && archFlag !== "--x64") {
  console.error("Usage: node scripts/build-mac-release-ci.mjs --arm64|--x64");
  process.exit(2);
}

/** Intel runners see more staple flakes; allow full rebuild retries after recovery fails. */
const maxBuildAttempts = archFlag === "--x64" ? 3 : 1;

/**
 * @returns {{ code: number; output: string }}
 */
function runElectronBuilder() {
  const result = spawnSync(
    "npx",
    ["electron-builder", "--mac", archFlag, "--publish", "never"],
    {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const code = result.status ?? 1;
  return { code, output };
}

for (let attempt = 1; attempt <= maxBuildAttempts; attempt++) {
  console.log(
    `[build-mac-release-ci] electron-builder attempt ${attempt}/${maxBuildAttempts} (${archFlag})`,
  );
  const { code, output } = runElectronBuilder();
  if (code === 0) {
    process.exit(0);
  }

  const recovered = await recoverFromStapleFailure(output);
  if (recovered) {
    console.log("[build-mac-release-ci] Recovered via xcrun stapler retry.");
    process.exit(0);
  }

  if (attempt < maxBuildAttempts) {
    console.log(
      "[build-mac-release-ci] Staple recovery unavailable or failed; retrying full mac build…",
    );
  }
}

console.error("[build-mac-release-ci] Mac build failed after all attempts.");
process.exit(1);
