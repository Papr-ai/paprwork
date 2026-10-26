/**
 * "Edit page" from Discover: open the owner's app and land on App info.
 * The app tab may not be mounted yet, so the request is parked until its publish bar asks.
 */
const pending = new Set<string>();
export const APP_INFO_REQUEST_EVENT = "papr-open-app-info";

export function requestAppInfo(appId: string): void {
  pending.add(appId);
  window.dispatchEvent(new CustomEvent(APP_INFO_REQUEST_EVENT, { detail: { appId } }));
}

/** True once per request: the caller should open App info for this app. */
export function takeAppInfoRequest(appId: string): boolean {
  return pending.delete(appId);
}
