import { AmplitudeEvents } from "../../src/core/telemetry/events";
import {
  getOAuthCompletedEventName,
  getOAuthFailedEventName,
  getOAuthStepEventName,
  logOAuthProviderStep,
  type OAuthProviderId,
  type OAuthProviderSource,
  type OAuthProviderStep,
} from "../../src/core/telemetry/oauthProviderSteps";
import { trackEvent } from "./telemetry";

export function trackOAuthProviderStep(
  provider: OAuthProviderId,
  step: OAuthProviderStep,
  properties?: Record<string, unknown> & { source?: OAuthProviderSource },
): void {
  const payload = { step, ...properties };
  logOAuthProviderStep(provider, step, payload);
  trackEvent(getOAuthStepEventName(provider), payload);
}

export function trackOAuthProviderCompleted(
  provider: OAuthProviderId,
  properties?: Record<string, unknown> & { source?: OAuthProviderSource },
): void {
  trackEvent(getOAuthCompletedEventName(provider), properties);
  trackEvent(AmplitudeEvents.PROVIDER_CONFIGURED, {
    provider,
    method: "oauth",
    ...properties,
  });
}

export function trackOAuthProviderFailed(
  provider: OAuthProviderId,
  error: string,
  properties?: Record<string, unknown> & { source?: OAuthProviderSource },
): void {
  trackEvent(getOAuthFailedEventName(provider), { error, ...properties });
}
