import type { PlatformId } from "./platformRegistry.js";
import { isGoogleChromeInstalled } from "./platformChromeEnv.js";

/**
 * LinkedIn must authenticate only in Papr-spawned Chrome (never import from the user's
 * personal Chrome profile). Other platforms may import from personal Chrome when cookies exist.
 */
export function allowsPersonalChromeCookieImport(platformId: PlatformId): boolean {
  return platformId !== "linkedin";
}

/**
 * When false, never read, sync, or recover session state from the in-app embedded tab.
 * LinkedIn with Google Chrome installed must use Papr-managed Chrome only — embedded cookie
 * sync would overwrite the live Chrome session stored in keychain.
 */
export function allowsEmbeddedPlatformSession(platformId: PlatformId): boolean {
  return !(platformId === "linkedin" && isGoogleChromeInstalled());
}
