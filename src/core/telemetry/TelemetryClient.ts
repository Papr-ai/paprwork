import { sanitizeTelemetryProperties } from "./sanitizeTelemetryProperties.js";
import {
  isTelemetrySendingEnabled,
  resolveTelemetryBaseUrl,
} from "./telemetryEnv.js";

const TELEMETRY_PATH = "/v1/telemetry/events";
const REQUEST_TIMEOUT_MS = 5000;

export interface TelemetryClientDeps {
  /** Resolved preference: user setting and/or env must be applied by caller. */
  getEffectiveEnabled: () => boolean;
  getAnonymousInstallId: () => string;
  appVersion: string;
  fetchImpl?: typeof fetch;
}

/**
 * POST anonymous events to Papr's proxy (Amplitude key server-side only).
 * Works from Electron main or gateway when given env-backed deps.
 */
export class TelemetryClient {
  private readonly deps: TelemetryClientDeps;
  private readonly fetchFn: typeof fetch;
  private disabledAfter404 = false;

  constructor(deps: TelemetryClientDeps) {
    this.deps = deps;
    this.fetchFn = deps.fetchImpl ?? fetch;
  }

  private endpointUrl(): string | null {
    const base = resolveTelemetryBaseUrl();
    if (!base) {
      return null;
    }
    return `${base}${TELEMETRY_PATH}`;
  }

  private canSend(): boolean {
    if (this.disabledAfter404) {
      return false;
    }
    if (!this.endpointUrl()) {
      return false;
    }
    const id = this.deps.getAnonymousInstallId();
    if (!id) {
      return false;
    }
    return isTelemetrySendingEnabled(() => this.deps.getEffectiveEnabled());
  }

  /**
   * Fire-and-forget safe wrapper for lifecycle hooks.
   */
  trackFireAndForget(
    eventName: string,
    properties?: Record<string, unknown>,
  ): void {
    void this.track(eventName, properties);
  }

  async track(
    eventName: string,
    properties?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.canSend()) {
      return;
    }

    const url = this.endpointUrl();
    if (!url) {
      return;
    }

    const installId = this.deps.getAnonymousInstallId();
    if (!installId) {
      return;
    }

    const merged: Record<string, unknown> = {
      client: "paprwork",
      app_version: this.deps.appVersion,
      platform: process.platform,
    };
    if (properties) {
      Object.assign(merged, properties);
    }
    const safeProps = sanitizeTelemetryProperties(merged);
    const body = {
      events: [
        {
          event_name: eventName,
          properties: safeProps,
          user_id: installId,
          timestamp: Date.now(),
        },
      ],
      anonymous_id: installId,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 404) {
        this.disabledAfter404 = true;
      }
    } catch {
      /* fail silent — never interrupt the app */
    } finally {
      clearTimeout(timer);
    }
  }
}

/** @deprecated Use TelemetryClientDeps */
export type TelemetryClientOptions = TelemetryClientDeps;
