/**
 * Inject the platform preview scripts before app scripts in local mini-app HTML.
 *
 * Two scripts, one slot:
 *   - papr-app-bridge         — paprAPI, runtime log forwarding, shell-booted signal
 *   - papr-preview-fetch-gate — pauses /api/* while the preview tab is hidden
 *
 * Both must run *before* any app script, and both are inlined rather than
 * referenced. `async defer` (added in #155 to stop a missing module blocking
 * load for ~11s) runs them after parsing, so an app that captured
 * `window.fetch` at module scope never saw the gate and an app that called
 * `window.paprAPI` got undefined — the slow case was fixed by making the
 * broken case silent. A blocking `<script src>` is correct but costs a round
 * trip before first paint, and under per-app origins the URL differs per app,
 * so no two apps can share the cached copy. See miniAppSdkSource.ts.
 *
 * The bridge goes first: an app script that throws at module scope should be
 * forwarded to the renderer, which needs the log bridge already installed.
 */

import { loadMiniAppSdkSource } from "./miniAppSdkSource.js";

/** Marker so the inlined form is still recognisable as already-injected. */
const MARKER = "data-papr-preview-scripts";

const BRIDGE_FILE = "papr-app-bridge.ts";
const GATE_FILE = "papr-preview-fetch-gate.ts";

/** Fallback when a bundle cannot be produced: blocking, never `async defer`. */
function scriptTag(file: string): string {
  return `<script src="/__papr__/${file.replace(/\.ts$/, ".js")}"></script>`;
}

async function previewScripts(): Promise<string> {
  const parts = await Promise.all(
    [BRIDGE_FILE, GATE_FILE].map(async (file) => {
      const code = await loadMiniAppSdkSource(file);
      return code === null
        ? scriptTag(file)
        : `<script ${MARKER}="${file}">${code}</script>`;
    }),
  );
  return parts.join("\n  ");
}

export async function injectMiniAppPreviewFetchGate(
  html: string,
): Promise<string> {
  if (html.includes(MARKER) || html.includes("papr-preview-fetch-gate.js")) {
    return html;
  }

  const scripts = await previewScripts();

  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n  ${scripts}`);
  }

  if (html.includes("<head ")) {
    return html.replace(/<head\s[^>]*>/, (match) => `${match}\n  ${scripts}`);
  }

  return `${scripts}\n${html}`;
}
