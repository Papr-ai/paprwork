#!/usr/bin/env node
/**
 * Test dashboard POST /api/v1/billing/ensure-developer-subscription.
 * Must run under Electron (encrypted settings + keychain).
 *
 * Usage:
 *   npm run test:ensure-developer-subscription
 *   npm run test:ensure-developer-subscription -- --workspace Ky99QwgeKl --org crwNcCnClI
 */

import electron from "electron";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvLocal } from "./lib/testEnv.mjs";

const { app } = electron;

function parseArgs(argv) {
  let workspaceId;
  let organizationId;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace" && argv[i + 1]) {
      workspaceId = argv[++i];
    } else if (argv[i] === "--org" && argv[i + 1]) {
      organizationId = argv[++i];
    }
  }
  return { workspaceId, organizationId };
}

async function importDist(modulePath) {
  const abs = join(process.cwd(), "dist", modulePath);
  return import(pathToFileURL(abs).href);
}

function readActiveWorkspacePointer() {
  try {
    const raw = readFileSync(join(homedir(), "Papr", ".active-workspace.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  loadEnvLocal();
  const cli = parseArgs(process.argv.slice(2));

  app.setName("Papr Work");
  await app.whenReady();

  const { CustomKeysStorage, SettingsStorage } = await importDist(
    "core/storage/index.js",
  );
  const { ensureDeveloperStripeSubscription } = await importDist(
    "electron/electron/ipc/paprBilling.js",
  );

  const customKeysStorage = new CustomKeysStorage();
  await customKeysStorage.initialize();
  const settingsStorage = new SettingsStorage();
  const profile = settingsStorage.getPaprProfile();

  const sessionFromKey =
    (await customKeysStorage.getKeyByName("PAPR_SESSION_TOKEN"))?.trim() || "";
  const sessionToken = sessionFromKey || profile?.sessionToken?.trim() || "";
  const userId = profile?.userId?.trim() || "";

  if (!sessionToken) {
    console.error("Not logged in — open Papr Work and sign in first.");
    app.quit();
    process.exit(2);
  }

  const pointer = readActiveWorkspacePointer();
  const workspaceId =
    cli.workspaceId ||
    profile?.workspaceId?.trim() ||
    pointer?.workspaceId ||
    "";
  const organizationId =
    cli.organizationId ||
    profile?.organizationId?.trim() ||
    pointer?.organizationId ||
    "";

  if (!workspaceId || !organizationId) {
    console.error(
      "Missing workspaceId/organizationId — pass --workspace and --org or select a workspace in Settings.",
    );
    app.quit();
    process.exit(2);
  }

  const platformUrl = (
    process.env.PAPR_PLATFORM_URL || "https://dashboard.papr.ai"
  ).replace(/\/$/, "");

  console.log("=== Papr ensure-developer-subscription probe (Electron session) ===");
  console.log(`Platform: ${platformUrl}`);
  console.log(`User: ${userId || "(unknown)"}`);
  console.log(`Workspace: ${workspaceId}`);
  console.log(`Organization: ${organizationId}`);
  console.log("");

  const started = performance.now();
  const result = await ensureDeveloperStripeSubscription({
    sessionToken,
    workspaceId,
    organizationId,
  });
  const elapsedMs = Math.round(performance.now() - started);

  if (!result) {
    console.error(`Failed (${elapsedMs}ms) — endpoint missing or request rejected (404 until platform is deployed)`);
    app.quit();
    process.exit(1);
  }

  console.log(`Completed (${elapsedMs}ms)`);
  console.log(JSON.stringify(result, null, 2));

  if (result.subscription?.status) {
    console.log("");
    console.log(`Stripe status: ${result.subscription.status}`);
    console.log(`isActive: ${result.subscription.isActive ?? false}`);
  }

  app.quit();
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit?.();
  process.exit(1);
});
