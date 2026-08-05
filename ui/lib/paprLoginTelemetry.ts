import { AmplitudeEvents } from "../../src/core/telemetry/events";
import {
  logPaprLoginStep,
  type PaprLoginSource,
  type PaprLoginStep,
} from "../../src/core/telemetry/paprLoginSteps";
import { trackEvent } from "./telemetry";

export function trackPaprLoginStep(
  step: PaprLoginStep,
  properties?: Record<string, unknown> & { source?: PaprLoginSource },
): void {
  const payload = { step, ...properties };
  logPaprLoginStep(step, payload);
  trackEvent(AmplitudeEvents.PAPR_LOGIN_STEP, payload);
}
