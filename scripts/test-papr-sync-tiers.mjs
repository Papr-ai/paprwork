#!/usr/bin/env node
/**
 * Manual smoke test for Papr Memory sync.getTiers (memory bootstrap catalog).
 *
 * Usage:
 *   node scripts/test-papr-sync-tiers.mjs
 *   node scripts/test-papr-sync-tiers.mjs --timeout 120000
 *
 * Requires PAPR_API_KEY in .env.local or env, and paprUserId in ~/Papr/data/settings.json
 * (login with Papr in Settings).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Papr from "@papr/memory";
import { loadEnvLocal, requirePaprApiKey } from "./lib/testEnv.mjs";
import {
  CATALOG_SYNC_TIERS_TIMEOUT_MS,
  MAX_CATALOG_TIER0,
  MAX_CATALOG_TIER1,
} from "../src/gateway/services/memoryGraphCatalog.ts";

loadEnvLocal();

function readPaprUserId() {
  const settingsPath = path.join(os.homedir(), "Papr", "data", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return settings.profile?.paprUserId?.trim() || null;
  } catch {
    return null;
  }
}

function parseTimeoutArg() {
  const idx = process.argv.indexOf("--timeout");
  if (idx === -1) {
    return CATALOG_SYNC_TIERS_TIMEOUT_MS;
  }
  const raw = process.argv[idx + 1];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 5_000) {
    console.error("❌ --timeout must be a number >= 5000 (ms)");
    process.exit(1);
  }
  return parsed;
}

async function main() {
  const apiKey = requirePaprApiKey();
  const userId = readPaprUserId();
  if (!userId) {
    console.error("❌ paprUserId missing — login with Papr in Settings first");
    process.exit(1);
  }

  const timeoutMs = parseTimeoutArg();
  console.log("\nPapr Memory sync.getTiers smoke test\n");
  console.log(`  user_id:        ${userId}`);
  console.log(`  max_tier0:      ${MAX_CATALOG_TIER0}`);
  console.log(`  max_tier1:      ${MAX_CATALOG_TIER1}`);
  console.log(`  timeout:        ${timeoutMs}ms`);
  console.log(`  app default:    ${CATALOG_SYNC_TIERS_TIMEOUT_MS}ms\n`);

  const client = new Papr({
    xAPIKey: apiKey,
    maxRetries: 0,
    timeout: timeoutMs,
  });

  const started = performance.now();
  process.stdout.write("Calling sync.getTiers ... ");

  try {
    const result = await client.sync.getTiers(
      {
        external_user_id: userId,
        max_tier0: MAX_CATALOG_TIER0,
        max_tier1: MAX_CATALOG_TIER1,
        include_embeddings: false,
      },
      { timeout: timeoutMs },
    );
    const elapsedMs = Math.round(performance.now() - started);
    const tier0 = result.tier0?.length ?? 0;
    const tier1 = result.tier1?.length ?? 0;

    console.log(`OK (${elapsedMs}ms)`);
    console.log(`  tier0 memories: ${tier0}`);
    console.log(`  tier1 memories: ${tier1}`);

    if (tier0 === 0 && tier1 === 0) {
      console.log("\n⚠️  Both tiers empty — API works but no priority memories for this user.");
    } else if (elapsedMs > 45_000) {
      console.log(
        `\n⚠️  Slow response (${elapsedMs}ms). Consider keeping timeout >= 120s.`,
      );
    } else {
      console.log("\n✅ sync.getTiers is working.");
    }

    process.exit(0);
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - started);
    const name = error instanceof Error ? error.constructor.name : "Error";
    const message = error instanceof Error ? error.message : String(error);

    console.log(`FAILED (${elapsedMs}ms)`);
    console.log(`  ${name}: ${message}`);

    if (name === "APIConnectionTimeoutError") {
      console.log(
        `\n💡 Try a longer timeout: node scripts/test-papr-sync-tiers.mjs --timeout 120000`,
      );
    }

    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
