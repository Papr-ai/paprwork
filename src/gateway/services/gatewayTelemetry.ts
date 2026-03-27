import { TelemetryClient } from "../../core/telemetry/TelemetryClient.js";
import { isTelemetrySendingEnabled } from "../../core/telemetry/telemetryEnv.js";

let client: TelemetryClient | null = null;

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
      appVersion: process.env.PAPRWORK_APP_VERSION?.trim() || "unknown",
    });
  }
  return client;
}
