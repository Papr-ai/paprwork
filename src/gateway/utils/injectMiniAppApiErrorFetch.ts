/**
 * Inject API error normalizer before preview fetch gate in local mini-app HTML.
 */

const API_ERROR_SCRIPT =
  '<script src="/__papr__/papr-api-error-fetch.js"></script>';

export function injectMiniAppApiErrorFetch(html: string): string {
  if (html.includes("papr-api-error-fetch.js")) {
    return html;
  }

  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n  ${API_ERROR_SCRIPT}`);
  }

  if (html.includes("<head ")) {
    return html.replace(/<head\s[^>]*>/, (match) => `${match}\n  ${API_ERROR_SCRIPT}`);
  }

  return `${API_ERROR_SCRIPT}\n${html}`;
}
