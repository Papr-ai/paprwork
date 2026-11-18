/**
 * Caps how many sign-in texts the gate's one box can trigger. Auth0 sends the
 * code as soon as we redirect, so without this anyone could run up SMS cost.
 * In-memory per instance — a floor, not the only guard (Twilio SMS Pumping
 * Protection + country allowlist sit behind it).
 */

const WINDOW_MS = 10 * 60 * 1000;
export const SMS_SIGNIN_LIMITS = { perIp: 5, perPhone: 3 };

const hits = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.set(key, list);
  return list;
}

/** True (and counts the attempt) when this IP and phone are under their caps. */
export function allowSmsSignInAttempt(ip: string, phone: string, now = Date.now()): boolean {
  const byIp = recent(`ip:${ip}`, now);
  const byPhone = recent(`phone:${phone}`, now);
  if (byIp.length >= SMS_SIGNIN_LIMITS.perIp || byPhone.length >= SMS_SIGNIN_LIMITS.perPhone) {
    return false;
  }
  byIp.push(now);
  byPhone.push(now);
  if (hits.size > 50_000) hits.clear();
  return true;
}

export function resetSmsSignInLimiter(): void {
  hits.clear();
}
