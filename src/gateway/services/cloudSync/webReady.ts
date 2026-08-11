/**
 * Cross-layer web-ready gate (SYNC_CONTRACT §12.1, SYNC_ARCHITECTURE_V2 §2.6).
 */

import * as path from "path";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { getCloudSyncService } from "../CloudSyncService.js";
import { verifyAppPushConvergence } from "./postPushVerify.js";
import { buildTursoSyncItemsReport } from "../tursoSyncStatus.js";
import { loadConvergenceStateForApp } from "./convergenceChecker.js";

export type WebReadyBlockReason =
  | "schema_drift"
  | "turso_pending"
  | "turso_quarantined"
  | "git_pending"
  | "git_failed"
  | "verify_failed"
  | "convergence_drift";

export interface WebReadyResult {
  ready: boolean;
  reason?: WebReadyBlockReason;
  detail?: string;
}

export type PublishLayerStatus =
  | "synced"
  | "republishing"
  | "not_web_ready"
  | "drift"
  | "error";

export interface PublishLayerReport {
  status: PublishLayerStatus;
  reason?: WebReadyBlockReason;
  detail?: string;
}

export async function buildPublishLayerReport(
  appId: string,
  options?: { paprDir?: string; cloudPublishing?: boolean },
): Promise<PublishLayerReport> {
  if (options?.cloudPublishing) {
    return { status: "republishing", detail: "Updating publish catalog…" };
  }

  const ready = await webReady(appId, options?.paprDir);
  if (ready.ready) {
    return { status: "synced" };
  }

  if (ready.reason === "convergence_drift") {
    return {
      status: "drift",
      reason: ready.reason,
      detail: ready.detail,
    };
  }

  if (ready.reason === "verify_failed" || ready.reason === "git_failed") {
    return {
      status: "error",
      reason: ready.reason,
      detail: ready.detail,
    };
  }

  return {
    status: "not_web_ready",
    reason: ready.reason,
    detail: ready.detail,
  };
}

export async function webReady(
  appId: string,
  paprDir?: string,
): Promise<WebReadyResult> {
  const root = paprDir ?? getPaprRoot();
  const appsRoot = path.join(root, "apps");
  const appPath = `apps/${appId}`;

  const sync = getCloudSyncService();
  const github = sync?.getGitHubSyncItemsReport() ?? {
    workspace: [],
    apps: [],
    jobs: [],
    queuedPaths: [],
    summary: {
      synced: 0,
      pending: 0,
      outdated: 0,
      failed: 0,
      updatesAvailable: 0,
      total: 0,
    },
  };
  const githubItem = github.apps.find((item) => item.relativePath === appPath);
  if (!githubItem) {
    return { ready: false, reason: "git_pending", detail: "App not in git sync report" };
  }
  if (githubItem.status === "failed") {
    return { ready: false, reason: "git_failed", detail: githubItem.lastError ?? "Git upload failed" };
  }
  if (githubItem.status !== "synced") {
    return { ready: false, reason: "git_pending", detail: `Git status: ${githubItem.status}` };
  }

  const turso = await buildTursoSyncItemsReport(appsRoot, appId);
  const sources = turso.sources.filter((source) => source.appId === appId);

  for (const source of sources) {
    if (source.schemaDrift) {
      return {
        ready: false,
        reason: "schema_drift",
        detail: `${source.alias}: local schema changed`,
      };
    }
    if (source.status === "quarantined") {
      return {
        ready: false,
        reason: "turso_quarantined",
        detail: `${source.alias}: ${source.quarantineReason ?? "quarantined"}`,
      };
    }
    if (source.status !== "synced" && source.status !== "empty") {
      return {
        ready: false,
        reason: "turso_pending",
        detail: `${source.alias}: ${source.status}`,
      };
    }
  }

  const verify = await verifyAppPushConvergence(appId, root);
  if (!verify.ok) {
    return {
      ready: false,
      reason: "verify_failed",
      detail: verify.errors.slice(0, 2).join("; "),
    };
  }

  const convergence = loadConvergenceStateForApp(appId, root);
  if (convergence?.driftTables && convergence.driftTables.length > 0) {
    return {
      ready: false,
      reason: "convergence_drift",
      detail: `Drift in ${convergence.driftTables.join(", ")}`,
    };
  }

  return { ready: true };
}
