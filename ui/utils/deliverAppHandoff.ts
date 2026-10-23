/**
 * Tell an open mini-app that Claude (or the web) just handed the user to it, so it can move to
 * the view the card named. The app may be already open (no reload) or mounting now, so post a
 * few times; the SDK (papr.onHandoff) dedupes by nonce.
 */
export const HANDOFF_RETRY_MS = [0, 400, 1200, 2500, 5000] as const;

export function deliverAppHandoff(
  appId: string,
  handoff: { view?: string | null; source?: string | null },
  deps: { doc?: Document; setTimeout?: (fn: () => void, ms: number) => unknown } = {},
): string {
  const doc = deps.doc ?? document;
  const later = deps.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms));
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const msg = {
    type: "papr-handoff",
    nonce,
    ...(handoff.view ? { view: handoff.view } : {}),
    source: handoff.source || "claude",
  };
  const post = () =>
    doc.querySelectorAll<HTMLIFrameElement>(`iframe[title="mini-app-${CSS.escape(appId)}"]`).forEach((f) => {
      try {
        f.contentWindow?.postMessage(msg, "*");
      } catch {
        /* detached frame */
      }
    });
  for (const ms of HANDOFF_RETRY_MS) later(post, ms);
  return nonce;
}
