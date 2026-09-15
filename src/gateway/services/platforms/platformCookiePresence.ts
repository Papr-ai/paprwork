import { normalizeCustomKeyName } from "../../../core/storage/customKeysDedupe.js";

/**
 * Deciding which of a platform's required cookies are stored, from key names alone.
 *
 * Absence is both the common answer and the expensive one to establish by reading a
 * secret. A platform the user never connected has no stored key, and `getKeyByName`
 * can only report that by waiting out its IPC timeout — then its fallback waits out
 * a second one against the same channel to the same process. Four unconnected
 * platforms checked in sequence cost ~120s that way, which is what left the gateway
 * with no quiet window for two minutes after a system resume.
 *
 * Key *names* answer absence far more cheaply: `listKeys` is one call covering every
 * platform, is cached, and falls back to reading the on-disk key index when main is
 * unresponsive — so a wedged main yields "not connected" instead of a stall.
 *
 * A name match does not prove the value is readable, so a caller that needs a usable
 * session must still read it. This narrows *which* names are worth reading.
 */
export function missingCookieKeyNames(
  requiredKeyNames: readonly string[],
  storedKeyNames: Iterable<string>,
): string[] {
  // Normalised with the same rule the real lookup uses. Comparing raw names would be
  // stricter than `getKeyByName`, so a key stored under different casing or with
  // stray whitespace would be reported missing while the lookup finds it — turning a
  // connected platform into a disconnected one.
  const stored = new Set<string>();
  for (const name of storedKeyNames) {
    stored.add(normalizeCustomKeyName(name));
  }

  return requiredKeyNames.filter(
    (name) => !stored.has(normalizeCustomKeyName(name)),
  );
}
