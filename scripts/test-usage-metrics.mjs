#!/usr/bin/env node
/**
 * Test dashboard /api/v1/usage/metrics with the logged-in Papr Work session.
 * Must run under Electron (encrypted settings + keychain).
 *
 * Usage:
 *   npm run test:usage-metrics
 *   npm run test:usage-metrics -- --workspace Ky99QwgeKl --org crwNcCnClI
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

function summarizeSubscription(subscription) {
  if (!subscription) {
    return { present: false };
  }
  return {
    present: true,
    status: subscription.status ?? null,
    isActive: subscription.isActive ?? null,
    planNickname: subscription.planNickname ?? null,
    parseTier: subscription.parseTier ?? null,
    isMeteredBillingOn: subscription.isMeteredBillingOn ?? null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? null,
  };
}

async function main() {
  loadEnvLocal();
  const cli = parseArgs(process.argv.slice(2));

  app.setName("Papr Work");
  await app.whenReady();

  const { CustomKeysStorage, SettingsStorage } = await importDist(
    "core/storage/index.js",
  );
  const { hasActivePaprSubscription } = await importDist(
    "core/utils/paprPlanLimits.js",
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

  const url = new URL(`${platformUrl}/api/v1/usage/metrics`);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("organizationId", organizationId);

  console.log("=== Papr usage/metrics probe (Electron session) ===");
  console.log(`Platform: ${platformUrl}`);
  console.log(`User: ${userId || "(unknown)"}`);
  console.log(`Workspace: ${workspaceId}`);
  console.log(`Organization: ${organizationId}`);
  if (pointer?.namespaceId) {
    console.log(`Active namespace: ${pointer.namespaceId} (${pointer.namespaceName ?? ""})`);
  }
  console.log(`GET ${url.pathname}${url.search}`);
  console.log("");

  const started = performance.now();
  let response;
  try {
    response = await fetch(url.toString(), {
      headers: { "X-Parse-Session-Token": sessionToken },
    });
  } catch (error) {
    console.error("Fetch failed:", error instanceof Error ? error.message : error);
    app.quit();
    process.exit(1);
  }

  const elapsedMs = Math.round(performance.now() - started);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }

  console.log(`HTTP ${response.status} (${elapsedMs}ms)`);

  if (!response.ok) {
    console.log(JSON.stringify(body, null, 2));
    app.quit();
    process.exit(1);
  }

  const subscriptionSummary = summarizeSubscription(body.subscription);
  console.log("Subscription (from metrics → Stripe via getSubscriptionInfo):");
  console.log(JSON.stringify(subscriptionSummary, null, 2));
  console.log("");
  console.log("Usage snapshot:");
  console.log(
    JSON.stringify(
      {
        memoriesCount: body.organization?.memoriesCount ?? null,
        storageCount: body.organization?.storageCount ?? null,
        miniInteractions: body.currentMonth?.totalInteractions ?? null,
      },
      null,
      2,
    ),
  );
  console.log("");

  const stripeStatus = body.subscription?.status;
  const wouldShowActivePlan = hasActivePaprSubscription({
    subscriptionStatus: stripeStatus,
  });
  const profileStatus = profile?.subscriptionStatus ?? null;

  console.log("Paprwork billing interpretation:");
  console.log(`  stripeStatus from metrics: ${stripeStatus ?? "(none)"}`);
  console.log(`  profile.subscriptionStatus (cached): ${profileStatus ?? "(none)"}`);
  console.log(`  hasActivePaprSubscription (Stripe-only): ${wouldShowActivePlan}`);
  if (profileStatus && profileStatus !== stripeStatus) {
    console.log(
      "  ⚠ cached profile status differs from metrics — re-open Plan & usage or sign out/in to refresh",
    );
  }
  if (!stripeStatus) {
    console.log(
      "  ✓ No Parse fallback — Paprwork treats this workspace as without active Stripe billing",
    );
  }

  app.quit();
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit?.();
  process.exit(1);
});
