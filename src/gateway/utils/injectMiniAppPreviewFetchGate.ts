/**
 * Install the platform scripts before app scripts can capture native fetch.
 *
 * Two of them, one slot:
 *   - papr-app-bridge         — paprAPI, runtime log forwarding, boot signal
 *   - papr-preview-fetch-gate — defers /api/* reads while the preview is hidden
 *
 * Bridge first: an app script that throws at module scope should reach the
 * renderer, which needs the log bridge already installed.
 */
import { loadInlineMiniAppSdk } from "./registerPaprMiniAppSdkRoutes.js";

const MARKER = "data-papr-preview-gate";

const PREVIEW_SDK_FILES = [
  "papr-app-bridge.ts",
  "papr-preview-fetch-gate.ts",
] as const;

async function inlineOrTag(file: string): Promise<string> {
  const route = `/__papr__/${file.replace(/\.ts$/, ".js")}`;
  try {
    return `<script ${MARKER}="${file}">${await loadInlineMiniAppSdk(file)}</script>`;
  } catch (error) {
    console.warn(
      `[Preview gate] Inline bundle unavailable for ${file}; using blocking SDK route`,
      error,
    );
    return `<script ${MARKER}="${file}" src="${route}"></script>`;
  }
}

export async function injectMiniAppPreviewFetchGate(
  html: string,
): Promise<string> {
  if (html.includes(MARKER)) return html;
  // Upgrade previously injected async tags rather than accepting the broken order.
  html = html.replace(
    /<script\b[^>]*\bsrc=["'][^"']*\/__papr__\/(?:papr-app-bridge|papr-preview-fetch-gate)\.js[^"']*["'][^>]*>\s*<\/script\s*>/gi,
    "",
  );
  const script = (await Promise.all(PREVIEW_SDK_FILES.map(inlineOrTag))).join(
    "\n",
  );
  const head = /<head\b[^>]*>/i;
  if (head.test(html))
    return html.replace(head, (match) => `${match}\n${script}`);
  // Keep the doctype first when the source has no explicit head.
  const doctype = /^(\s*<!doctype[^>]*>)/i;
  if (doctype.test(html))
    return html.replace(doctype, (match) => `${match}\n${script}`);
  return `${script}\n${html}`;
}
