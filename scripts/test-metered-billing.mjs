#!/usr/bin/env node
/**
 * Round-trip test for Parse metered billing toggle (same mutation as dashboard).
 * Must run under Electron (encrypted settings + keychain).
 *
 * Usage:
 *   npm run test:metered-billing
 *   npm run test:metered-billing -- --dry-run
 *   npm run test:metered-billing -- --enable
 *   npm run test:metered-billing -- --disable
 *   npm run test:metered-billing -- --no-restore
 */

import electron from "electron";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runParseGraphQL } from "./lib/parseGraphqlSession.mjs";
import { loadEnvLocal } from "./lib/testEnv.mjs";

const { app } = electron;

function parseArgs(argv) {
  let workspaceId;
  let organizationId;
  let dryRun = false;
  let noRestore = false;
  /** @type {boolean | undefined} */
  let targetEnabled;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace" && argv[i + 1]) {
      workspaceId = argv[++i];
    } else if (argv[i] === "--org" && argv[i + 1]) {
      organizationId = argv[++i];
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--no-restore") {
      noRestore = true;
    } else if (argv[i] === "--enable") {
      targetEnabled = true;
    } else if (argv[i] === "--disable") {
      targetEnabled = false;
    }
  }

  return { workspaceId, organizationId, dryRun, noRestore, targetEnabled };
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

async function fetchUsageMetrics(sessionToken, workspaceId, organizationId) {
  const platformUrl = (
    process.env.PAPR_PLATFORM_URL || "https://dashboard.papr.ai"
  ).replace(/\/$/, "");
  const url = new URL(`${platformUrl}/api/v1/usage/metrics`);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("organizationId", organizationId);

  const response = await fetch(url.toString(), {
    headers: { "X-Parse-Session-Token": sessionToken },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `usage/metrics HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body;
}

function die(code, ...messages) {
  for (const message of messages) {
    if (code === 0) {
      console.log(message);
    } else {
      console.error(message);
    }
  }
  app.quit();
  // Electron defers process.exit — block further async work.
  return new Promise(() => {
    setImmediate(() => process.exit(code));
  });
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
  const {
    buildPlanSummary,
    invalidatePlanSummaryCache,
    setSubscriptionMeteredBilling,
  } = await importDist("electron/electron/ipc/paprBilling.js");

  const customKeysStorage = new CustomKeysStorage();
  await customKeysStorage.initialize();
  const settingsStorage = new SettingsStorage();
  const profile = settingsStorage.getPaprProfile();

  const sessionFromKey =
    (await customKeysStorage.getKeyByName("PAPR_SESSION_TOKEN"))?.trim() || "";
  const sessionToken = sessionFromKey || profile?.sessionToken?.trim() || "";
  const userId = profile?.userId?.trim() || "";

  if (!sessionToken) {
    await die(2, "Not logged in — open Papr Work and sign in first.");
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
    await die(
      2,
      "Missing workspaceId/organizationId — pass --workspace and --org or select a workspace in Settings.",
    );
  }

  const services = {
    settingsStorage,
    runGraphQL: (query, variables) =>
      runParseGraphQL(sessionToken, query, variables),
  };

  console.log("=== Papr metered billing round-trip (Electron session) ===");
  console.log(`User: ${userId || "(unknown)"}`);
  console.log(`Workspace: ${workspaceId}`);
  console.log(`Organization: ${organizationId}`);
  console.log("");

  invalidatePlanSummaryCache();
  const beforeSummary = await buildPlanSummary(services);

  console.log("Plan summary (before):");
  console.log(
    JSON.stringify(
      {
        planName: beforeSummary.planName,
        planTier: beforeSummary.planTier,
        subscriptionStatus: beforeSummary.subscriptionStatus ?? null,
        canManageBilling: beforeSummary.canManageBilling,
        subscriptionObjectId: beforeSummary.subscriptionObjectId ?? null,
        isMeteredBillingOn: beforeSummary.isMeteredBillingOn,
      },
      null,
      2,
    ),
  );
  console.log("");

  const blockers = [];
  if (!beforeSummary.canManageBilling) {
    blockers.push("you are not the workspace owner (cannot toggle metered billing)");
  }
  if (!beforeSummary.subscriptionObjectId) {
    blockers.push("no Parse subscription objectId on this workspace");
  }
  if (!hasActivePaprSubscription(beforeSummary)) {
    blockers.push(
      "Stripe subscription is not active/trialing (metered billing requires an active plan)",
    );
  }

  const originalEnabled = beforeSummary.isMeteredBillingOn;
  const nextEnabled =
    cli.targetEnabled !== undefined ? cli.targetEnabled : !originalEnabled;

  if (cli.dryRun) {
    if (blockers.length > 0) {
      await die(
        3,
        `Dry run blocked: ${blockers.join("; ")}`,
        `Current isMeteredBillingOn=${originalEnabled}`,
      );
    }
    await die(
      0,
      `Dry run — would set isMeteredBillingOn=${nextEnabled} (currently ${originalEnabled})`,
    );
  }

  if (blockers.length > 0) {
    await die(3, `Skip: ${blockers.join("; ")}`);
  }

  if (nextEnabled === originalEnabled && cli.targetEnabled === undefined) {
    console.log(
      `Already ${originalEnabled ? "on" : "off"} — toggling to ${!originalEnabled} for round-trip verification.`,
    );
  }

  const toggleTo = cli.targetEnabled !== undefined ? nextEnabled : !originalEnabled;

  console.log(`Setting metered billing → ${toggleTo} ...`);
  const started = performance.now();
  await setSubscriptionMeteredBilling(services, toggleTo);
  console.log(`Parse mutation OK (${Math.round(performance.now() - started)}ms)`);

  await new Promise((resolve) => setTimeout(resolve, 1500));
  invalidatePlanSummaryCache();

  const afterSummary = await buildPlanSummary(services);
  const metrics = await fetchUsageMetrics(sessionToken, workspaceId, organizationId);
  const metricsMetered = metrics.subscription?.isMeteredBillingOn ?? null;

  console.log("");
  console.log("After toggle:");
  console.log(
    JSON.stringify(
      {
        planSummaryIsMeteredBillingOn: afterSummary.isMeteredBillingOn,
        usageMetricsIsMeteredBillingOn: metricsMetered,
      },
      null,
      2,
    ),
  );

  if (afterSummary.isMeteredBillingOn !== toggleTo) {
    await die(
      1,
      `FAIL: plan summary still shows isMeteredBillingOn=${afterSummary.isMeteredBillingOn}, expected ${toggleTo}`,
    );
  }
  if (metricsMetered !== toggleTo) {
    console.warn(
      `WARN: usage/metrics still shows isMeteredBillingOn=${metricsMetered} (plan summary updated). May need a few seconds to propagate.`,
    );
  }

  console.log("PASS: metered billing toggle persisted in plan summary.");

  if (!cli.noRestore && toggleTo !== originalEnabled) {
    console.log("");
    console.log(`Restoring original value → ${originalEnabled} ...`);
    await setSubscriptionMeteredBilling(services, originalEnabled);
    invalidatePlanSummaryCache();
    const restored = await buildPlanSummary(services);
    if (restored.isMeteredBillingOn !== originalEnabled) {
      await die(
        1,
        `FAIL: restore left isMeteredBillingOn=${restored.isMeteredBillingOn}, expected ${originalEnabled}`,
      );
    }
    console.log("PASS: restored original metered billing state.");
  } else if (cli.noRestore) {
    console.log("Left metered billing changed (--no-restore).");
  }

  app.quit();
  process.exit(0);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit?.();
  process.exit(1);
});
