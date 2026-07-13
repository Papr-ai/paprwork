/**
 * Mini-app boot watchdog — DISABLED.
 *
 * The original implementation injected a large inline script into every
 * mini-app index.html. This caused the Electron webview to become
 * unresponsive — the injected script blocked module loading, resulting
 * in blank/frozen mini-app iframes.
 *
 * TODO: Re-implement as a lightweight postMessage-based handshake
 * between the parent MiniAppView and the iframe, instead of injecting
 * inline scripts into the served HTML.
 */

export const MODULE_RAN_MARKER = "";

export function injectMiniAppBootWatchdog(html: string): string {
  return html;
}

export function appendModuleRanMarker(code: string): string {
  return code;
}
