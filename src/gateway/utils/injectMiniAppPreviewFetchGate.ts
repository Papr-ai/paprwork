/** Install the gate before app scripts can capture native fetch. */
import { loadInlineMiniAppSdk } from "./registerPaprMiniAppSdkRoutes.js";

const MARKER = "data-papr-preview-gate";
export async function injectMiniAppPreviewFetchGate(
  html: string,
): Promise<string> {
  if (html.includes(MARKER)) return html;
  // Upgrade previously injected async tags rather than accepting the broken order.
  html = html.replace(
    /<script\b[^>]*\bsrc=["'][^"']*\/__papr__\/papr-preview-fetch-gate\.js[^"']*["'][^>]*>\s*<\/script\s*>/gi,
    "",
  );
  let script: string;
  try {
    script = `<script ${MARKER}>${await loadInlineMiniAppSdk("papr-preview-fetch-gate.ts")}</script>`;
  } catch (error) {
    console.warn(
      "[Preview gate] Inline bundle unavailable; using blocking SDK route",
      error,
    );
    script = `<script ${MARKER} src="/__papr__/papr-preview-fetch-gate.js"></script>`;
  }
  const head = /<head\b[^>]*>/i;
  if (head.test(html))
    return html.replace(head, (match) => `${match}\n${script}`);
  // Keep the doctype first when the source has no explicit head.
  const doctype = /^(\s*<!doctype[^>]*>)/i;
  if (doctype.test(html))
    return html.replace(doctype, (match) => `${match}\n${script}`);
  return `${script}\n${html}`;
}
