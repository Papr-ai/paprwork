/**
 * Inject preview fetch gate before app scripts in local mini-app HTML.
 */

const GATE_SCRIPT =
  '<script src="/__papr__/papr-preview-fetch-gate.js"></script>';

export function injectMiniAppPreviewFetchGate(html: string): string {
  if (html.includes("papr-preview-fetch-gate.js")) {
    return html;
  }

  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n  ${GATE_SCRIPT}`);
  }

  if (html.includes("<head ")) {
    return html.replace(/<head\s[^>]*>/, (match) => `${match}\n  ${GATE_SCRIPT}`);
  }

  return `${GATE_SCRIPT}\n${html}`;
}
