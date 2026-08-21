import { TelemetryClient } from "../../core/telemetry/TelemetryClient.js";
import { AmplitudeEvents } from "../../core/telemetry/events.js";
import { isTelemetryPackagedFromEnv } from "../../core/telemetry/telemetryProductContext.js";
import { isTelemetrySendingEnabled } from "../../core/telemetry/telemetryEnv.js";
import { getPaprUserId } from "../utils/paprUserId.js";
import {
  getDesktopSyncProtocol,
  registerSyncV3TelemetrySink,
} from "./syncV3/index.js";
import type { SyncV3MetricName } from "../../core/types/syncV3.js";

let client: TelemetryClient | null = null;
let syncV3SinkRegistered = false;

function ensureSyncV3TelemetrySink(telemetry: TelemetryClient): void {
  if (syncV3SinkRegistered) return;
  syncV3SinkRegistered = true;
  registerSyncV3TelemetrySink((name: SyncV3MetricName, value: number) => {
    telemetry.trackFireAndForget(AmplitudeEvents.SYNC_V3_METRIC, {
      metric_name: name,
      metric_value: value,
      sync_protocol: getDesktopSyncProtocol(),
    });
  });
}

/**
 * Gateway-process telemetry (same proxy as Electron). Enabled when the parent
 * process sets PAPRWORK_TELEMETRY_ENABLED=true and PAPRWORK_TELEMETRY_ANONYMOUS_ID.
 */
export function getGatewayTelemetry(): TelemetryClient {
  if (!client) {
    client = new TelemetryClient({
      getEffectiveEnabled: () =>
        isTelemetrySendingEnabled(
          () => process.env.PAPRWORK_TELEMETRY_ENABLED === "true",
        ),
      getAnonymousInstallId: () =>
        process.env.PAPRWORK_TELEMETRY_ANONYMOUS_ID?.trim() ?? "",
      getPaprUserId: () => getPaprUserId() ?? "",
      getIsPackaged: () => isTelemetryPackagedFromEnv(),
      appVersion: process.env.PAPRWORK_APP_VERSION?.trim() || "unknown",
    });
    ensureSyncV3TelemetrySink(client);
  }
  return client;
}
