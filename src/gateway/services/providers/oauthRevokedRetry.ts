/**
 * Recovery for a subscription token that was replaced mid-turn.
 *
 * Refreshing an OAuth access token makes the provider revoke the one it
 * replaces. A long agent turn resolved its token once, so after a background
 * refresh every further model call sends a revoked token and gets a 401.
 * Nothing in that error means the user's login is bad — the current token in
 * the store is fine — so the right response is to fetch it and retry once.
 */

export function isOAuthTokenRejection(err: unknown): boolean {
  if (err == null) return false;
  const record = typeof err === "object" ? (err as Record<string, unknown>) : {};
  if (record.statusCode === 401 || record.status === 401) return true;
  let text = "";
  try {
    text = typeof err === "string" ? err : JSON.stringify(err) + String(record.message ?? "");
  } catch {
    text = String(record.message ?? err);
  }
  if (/spend limit|usage limit|credit balance/i.test(text)) return false;
  return (
    /\b401\b/.test(text) ||
    /OAuth access token (has been revoked|is invalid|has expired)/i.test(text) ||
    /authentication_error/.test(text)
  );
}

/**
 * Ask for the current token and install it on the live stream options.
 * Returns true only when a different token was found, so a genuinely dead
 * login falls through to the normal error instead of looping.
 */
export async function adoptRefreshedToken(
  streamOptions: { apiKey: string },
  refreshAuth: (() => Promise<string | null>) | undefined,
): Promise<boolean> {
  if (!refreshAuth) return false;
  try {
    const next = await refreshAuth();
    if (!next || next === streamOptions.apiKey) return false;
    streamOptions.apiKey = next;
    return true;
  } catch {
    return false;
  }
}
