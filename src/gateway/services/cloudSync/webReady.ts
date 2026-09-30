/**
 * Cross-layer web-ready gate (SYNC_CONTRACT §12.1).
 */

import * as path from "path";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import {
  buildTursoSyncItemsReport,
  type TursoSyncItemsReport,
} from "../tursoSyncStatus.js";

export type WebReadyBlockReason =
  | "schema_drift"
  | "turso_pending"
  | "turso_quarantined"
  | "writer_pending"
  | "writer_conflict";

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
  options?: {
    paprDir?: string;
    cloudPublishing?: boolean;
    /** App has an active Papr cloud share link (enabled + shareUrl). */
    publishLive?: boolean;
    /** When set, webReady skips a second buildTursoSyncItemsReport (e.g. /api/sync/items). */
    tursoReport?: TursoSyncItemsReport;
  },
): Promise<PublishLayerReport> {
  if (options?.cloudPublishing) {
    return { status: "republishing", detail: "Updating publish catalog…" };
  }

  const ready = await webReady(appId, options?.paprDir, {
    tursoReport: options?.tursoReport,
  });
  if (ready.ready) {
    return ready.detail
      ? { status: "synced", detail: ready.detail }
      : { status: "synced" };
  }

  if (
    options?.publishLive &&
    (ready.reason === "writer_pending" || ready.reason === "writer_conflict")
  ) {
    return {
      status: "synced",
      detail:
        ready.reason === "writer_pending"
          ? "Live on the web — writer sync is catching up"
          : (ready.detail ?? "Live on the web"),
    };
  }

  if (ready.reason === "writer_conflict") {
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

export function evaluateTursoReportForWebReady(
  appId: string,
  turso: TursoSyncItemsReport,
): WebReadyResult {
  const sources = turso.sources.filter((source) => source.appId === appId);

  for (const source of sources) {
    if (source.remoteCheckFailed) {
      continue;
    }
    const legacyArtifactDriftOnly =
      source.schemaDrift === true &&
      (source.legacyArtifactTables?.length ?? 0) > 0 &&
      source.syncMode !== "replica";
    if (source.schemaDrift && !legacyArtifactDriftOnly) {
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

  return { ready: true };
}

export async function webReady(
  appId: string,
  paprDir?: string,
  options?: { tursoReport?: TursoSyncItemsReport },
): Promise<WebReadyResult> {
  const root = paprDir ?? getPaprRoot();
  const appsRoot = path.join(root, "apps");

  const { isAppWriterSyncReady } = await import("../syncV3/writerSyncStatus.js");
  const writerReady = await isAppWriterSyncReady(appId);
  if (!writerReady.ready) {
    const isConflict = writerReady.detail?.includes("conflict");
    return {
      ready: false,
      reason: isConflict ? "writer_conflict" : "writer_pending",
      detail: writerReady.detail,
    };
  }

  const turso =
    options?.tursoReport ??
    (await buildTursoSyncItemsReport(appsRoot, appId));

  return evaluateTursoReportForWebReady(appId, turso);
}
