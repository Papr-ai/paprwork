/** Base CSS injected into every mini-app HTML — common utilities agents often forget. */
export const MINI_APP_BASE_STYLE_TAG = `<style data-paprwork-base>
.hidden{display:none!important}
</style>`;

/** Inject paprwork base + optional brand CSS variables into mini-app HTML (idempotent). */
export function injectMiniAppBaseStyles(
  html: string,
  brandStyleTag?: string,
): string {
  if (!html.includes("<head")) {
    return html;
  }

  let result = html;

  if (brandStyleTag && !result.includes("data-paprwork-brand")) {
    result = result.replace(/<head([^>]*)>/i, `<head$1>\n${brandStyleTag}`);
  }

  if (!result.includes("data-paprwork-base")) {
    result = result.replace(/<head([^>]*)>/i, `<head$1>\n${MINI_APP_BASE_STYLE_TAG}`);
  }

  return result;
}
