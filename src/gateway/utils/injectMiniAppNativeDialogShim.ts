/**
 * Inject platform native-dialog shim before app scripts in mini-app HTML.
 */

const SHIM_SCRIPT =
  '<script src="/__papr__/papr-native-dialog-shim.js"></script>';

export function injectMiniAppNativeDialogShim(html: string): string {
  if (html.includes("papr-native-dialog-shim.js")) {
    return html;
  }

  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n  ${SHIM_SCRIPT}`);
  }

  if (html.includes("<head ")) {
    return html.replace(/<head\s[^>]*>/, (match) => `${match}\n  ${SHIM_SCRIPT}`);
  }

  return `${SHIM_SCRIPT}\n${html}`;
}
