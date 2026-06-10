/** Base CSS injected into every mini-app HTML — common utilities agents often forget. */
export const MINI_APP_BASE_STYLE_TAG = `<style data-paprwork-base>
.hidden{display:none!important}
</style>`;

/** Inject paprwork base styles into mini-app HTML (idempotent). */
export function injectMiniAppBaseStyles(html: string): string {
  if (!html.includes("<head")) {
    return html;
  }
  if (html.includes("data-paprwork-base")) {
    return html;
  }
  return html.replace(/<head([^>]*)>/i, `<head$1>\n${MINI_APP_BASE_STYLE_TAG}`);
}
