/** Stagger hidden warm-tab iframe loads so they do not all hit the gateway at once. */
export const WARM_IFRAME_ACTIVATION_BASE_MS = 200;
export const WARM_IFRAME_ACTIVATION_STEP_MS = 300;
export const WARM_IFRAME_ACTIVATION_SLOTS = 6;

function hashAppId(appId: string): number {
  let hash = 0;
  for (let i = 0; i < appId.length; i += 1) {
    hash = (hash + appId.charCodeAt(i)) % 10_007;
  }
  return hash;
}

/** Delay before a hidden LRU-warm tab starts loading its iframe (visible tabs use 0). */
export function warmIframeActivationDelayMs(appId: string): number {
  const slot = hashAppId(appId) % WARM_IFRAME_ACTIVATION_SLOTS;
  return WARM_IFRAME_ACTIVATION_BASE_MS + slot * WARM_IFRAME_ACTIVATION_STEP_MS;
}
