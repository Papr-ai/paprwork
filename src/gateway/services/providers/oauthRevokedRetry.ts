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

/**
 * Open a model stream and, if its first answer is a token rejection, adopt the
 * current token and open it once more. Used by calls that build their own
 * request options (wrap-up, text-first retry) and so never see the live ones
 * the tool loop updates. A rejection that cannot be recovered is surfaced
 * unchanged, so the caller's existing error handling still applies.
 */
export async function* streamWithTokenRetry<E extends { type?: string }>(
  open: (options: Record<string, unknown>) => AsyncIterable<E>,
  options: Record<string, unknown>,
  refreshAuth?: () => Promise<string | null>,
): AsyncGenerator<E> {
  let current = options;
  let retried = false;
  while (true) {
    let started = false;
    let swallowedEvent: E | undefined;
    let swallowedError: unknown;
    let rejected = false;
    try {
      for await (const event of open(current)) {
        if (
          !retried && !started && event.type === "error" &&
          isOAuthTokenRejection((event as { error?: unknown }).error ?? event)
        ) {
          swallowedEvent = event;
          rejected = true;
          break;
        }
        if (event.type !== "start") started = true;
        yield event;
      }
    } catch (err) {
      if (retried || started || !isOAuthTokenRejection(err)) throw err;
      swallowedError = err;
      rejected = true;
    }
    if (!rejected) return;
    retried = true;
    const next = { ...current } as Record<string, unknown> & { apiKey: string };
    if (!(await adoptRefreshedToken(next, refreshAuth))) {
      if (swallowedEvent) yield swallowedEvent;
      else throw swallowedError;
      return;
    }
    current = next;
  }
}
