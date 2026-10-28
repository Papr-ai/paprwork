#!/usr/bin/env node
/**
 * Detect transient Apple staple / CloudKit failures in CI and retry xcrun stapler.
 * Used when electron-builder notarization succeeds but stapling the ticket fails (Error 68).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const APP_NAME = "Papr Work.app";

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isStapleFailureOutput(text) {
  if (!text || typeof text !== "string") {
    return false;
  }
  const lower = text.toLowerCase();
  if (/failed to staple/.test(lower)) {
    return true;
  }
  if (/staple and validate action failed/.test(lower)) {
    return true;
  }
  if (/error 68/.test(lower)) {
    return true;
  }
  if (/nsurlerrordomain/.test(lower) && /-1005/.test(lower)) {
    return true;
  }
  if (/api\.apple-cloudkit\.com/.test(lower) && /staple|ticket|notariz/.test(lower)) {
    return true;
  }
  return false;
}

/**
 * @param {string} [releaseDir]
 * @returns {string[]}
 */
export function findStapleTargets(releaseDir = "release") {
  /** @type {string[]} */
  const targets = [];
  if (!existsSync(releaseDir)) {
    return targets;
  }
  for (const name of readdirSync(releaseDir)) {
    if (name.endsWith(".pkg")) {
      targets.push(join(releaseDir, name));
    }
  }
  for (const dir of ["mac", "mac-arm64"]) {
    const appPath = join(releaseDir, dir, APP_NAME);
    if (existsSync(appPath)) {
      targets.push(appPath);
    }
  }
  return targets;
}

/**
 * @param {string} absPath
 * @param {{ maxAttempts?: number; initialDelayMs?: number; maxDelayMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function staplePathWithRetry(absPath, options = {}) {
  const maxAttempts = options.maxAttempts ?? 6;
  let delayMs = options.initialDelayMs ?? 15_000;
  const maxDelayMs = options.maxDelayMs ?? 120_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const staple = spawnSync("xcrun", ["stapler", "staple", absPath], {
      encoding: "utf8",
    });
    const validate = spawnSync("xcrun", ["stapler", "validate", absPath], {
      encoding: "utf8",
    });
    if (staple.status === 0 && validate.status === 0) {
      console.log(
        `[macos-staple-retry] stapled and validated ${absPath} (attempt ${attempt}/${maxAttempts})`,
      );
      return true;
    }
    const errSnippet = `${staple.stderr ?? ""}${validate.stderr ?? ""}`.slice(0, 800);
    console.warn(
      `[macos-staple-retry] attempt ${attempt}/${maxAttempts} failed for ${absPath}: ${errSnippet}`,
    );
    if (attempt < maxAttempts) {
      console.log(`[macos-staple-retry] waiting ${delayMs}ms before retry…`);
      await sleep(delayMs);
      delayMs = Math.min(Math.round(delayMs * 1.5), maxDelayMs);
    }
  }
  return false;
}

/**
 * @param {string} buildLog
 * @param {string} [releaseDir]
 * @returns {Promise<boolean>}
 */
export async function recoverFromStapleFailure(buildLog, releaseDir = "release") {
  if (!isStapleFailureOutput(buildLog)) {
    console.error(
      "[macos-staple-retry] Build log does not look like a staple/CloudKit failure; not recovering.",
    );
    return false;
  }
  const targets = findStapleTargets(releaseDir);
  if (targets.length === 0) {
    console.error(
      "[macos-staple-retry] Staple failure detected but no .pkg or .app found under release/.",
    );
    return false;
  }
  console.log(`[macos-staple-retry] Retrying staple for ${targets.length} artifact(s)…`);
  for (const target of targets) {
    const ok = await staplePathWithRetry(target);
    if (!ok) {
      return false;
    }
  }
  return true;
}
