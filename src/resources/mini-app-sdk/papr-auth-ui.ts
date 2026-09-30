/**
 * Shared Papr sign-in UI for cloud apps.
 * Used by papr-auth-guard overlay and Cloud App Host auth callback HTML.
 */

export const PAPR_BRAND_BLUE = "#0080FF";
export const PAPR_BRAND_BLUE_HOVER = "#0070E0";

const PAPR_FOLD_SVG = `<svg viewBox="0 0 300 270" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path fill-rule="evenodd" clip-rule="evenodd" d="M300 262C300 266.418 296.418 270 292 270L54.5454 270L300 0L300 262Z" fill="${PAPR_BRAND_BLUE}"/>
  <path opacity="0.04" fill-rule="evenodd" clip-rule="evenodd" d="M54.5454 40.5L54.5454 67.5L300 3.05176e-05L54.5454 40.5Z" fill="#212721"/>
  <path opacity="0.48" fill-rule="evenodd" clip-rule="evenodd" d="M54.5455 270L0 81L300 0L54.5455 270Z" fill="${PAPR_BRAND_BLUE}"/>
</svg>`;

const PAPR_LOGO_MARK_SVG = `<svg width="40" height="40" viewBox="0 0 105 124" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M27.9998 101.5C-11.5 158 6.99988 51 43.4008 60.5002C99.2884 75.0861 115.18 20.7781 83.6804 8.27816C40.2693 -8.94844 51.9998 65 27.9998 101.5Z" stroke="${PAPR_BRAND_BLUE}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export function escapePaprAuthHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapePaprAuthHtmlAttribute(value: string): string {
  return escapePaprAuthHtml(value).replaceAll("'", "&#39;");
}

export const PAPR_AUTH_OVERLAY_STYLES = `
  .papr-auth-overlay {
    position: fixed; inset: 0; z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    font-family: "SF UI Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 24px;
  }
  .papr-auth-overlay__shell {
    display: flex;
    width: min(920px, 100%);
    max-height: min(90vh, 640px);
    border-radius: 20px;
    overflow: hidden;
    box-shadow: 0 24px 80px rgba(15, 23, 42, 0.28);
    background: #fff;
  }
  .papr-auth-overlay__left {
    flex: 1 1 52%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 36px 28px;
    background: rgba(255, 255, 255, 0.96);
  }
  .papr-auth-overlay__right {
    flex: 0 0 48%;
    display: none;
    align-items: center;
    justify-content: center;
    background: #fff;
    padding: 24px;
  }
  .papr-auth-overlay__form { width: 100%; max-width: 360px; text-align: center; }
  .papr-auth-overlay__title {
    margin: 0 0 10px;
    font-family: Montserrat, system-ui, sans-serif;
    font-size: 28px;
    font-weight: 700;
    color: #111827;
  }
  .papr-auth-overlay__message {
    margin: 0 0 24px;
    font-size: 15px;
    line-height: 1.5;
    color: #667085;
  }
  .papr-auth-overlay__btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: 14px 24px;
    border: none;
    border-radius: 12px;
    background: ${PAPR_BRAND_BLUE};
    color: #fff;
    font-size: 15px;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 128, 255, 0.2);
  }
  .papr-auth-overlay__btn:hover { background: ${PAPR_BRAND_BLUE_HOVER}; }
  .papr-auth-overlay__dismiss {
    display: block;
    margin: 14px auto 0;
    padding: 8px 16px;
    background: none;
    border: 1px solid #E4E7EC;
    border-radius: 8px;
    color: #667085;
    font-size: 13px;
    cursor: pointer;
  }
  .papr-auth-overlay__brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 28px;
  }
  .papr-auth__logo-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .papr-auth__wordmark {
    font-family: Montserrat, system-ui, -apple-system, sans-serif;
    font-size: 28px;
    font-weight: 700;
    color: #111827;
    letter-spacing: -0.02em;
  }
  .papr-auth-overlay__fold { width: min(200px, 80%); }
  .papr-auth-overlay__fold svg { width: 100%; height: auto; display: block; }
  @media (min-width: 720px) {
    .papr-auth-overlay__right { display: flex; }
  }
`;

/** Turn a published app slug into a readable label (e.g. weekly-war-room → Weekly War Room). */
export function humanizeAppSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** Derive an app label from a published-app return path (/namespaceId/slug/…). */
export function appLabelFromReturnTo(returnTo: string): string | undefined {
  const pathOnly = returnTo.split("?")[0] ?? returnTo;
  const segments = pathOnly.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  const slug = segments[1];
  if (!slug) return undefined;
  return humanizeAppSlug(slug);
}

export interface PaprAuthCallbackPageParams {
  returnTo: string;
  appLabel?: string;
}

const PAPR_AUTH_CALLBACK_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: "SF UI Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #111827;
    background: #F5F5F7;
  }
  .papr-auth-callback {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 24px;
  }
  .papr-auth-callback__card {
    width: 100%;
    max-width: 360px;
    text-align: center;
  }
  .papr-auth-callback__spinner {
    width: 32px;
    height: 32px;
    margin: 0 auto 20px;
    border: 3px solid rgba(0, 128, 255, 0.12);
    border-top-color: ${PAPR_BRAND_BLUE};
    border-radius: 50%;
    animation: papr-auth-spin 0.8s linear infinite;
  }
  .papr-auth-callback__title {
    margin: 0 0 8px;
    font-size: 22px;
    font-weight: 600;
    line-height: 1.3;
    color: #111827;
  }
  .papr-auth-callback__subtitle {
    margin: 0;
    font-size: 15px;
    line-height: 1.5;
    color: #667085;
  }
  .papr-auth-callback__fallback {
    margin-top: 28px;
  }
  .papr-auth-callback__btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 12px 20px;
    border-radius: 10px;
    font-size: 15px;
    font-weight: 600;
    color: #fff;
    background: ${PAPR_BRAND_BLUE};
    text-decoration: none;
    box-shadow: 0 2px 8px rgba(0, 128, 255, 0.2);
  }
  .papr-auth-callback__btn:hover {
    background: ${PAPR_BRAND_BLUE_HOVER};
  }
  @keyframes papr-auth-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1C1C1E; color: #F5F5F7; }
    .papr-auth-callback__title { color: #F5F5F7; }
    .papr-auth-callback__subtitle { color: #A1A1AA; }
  }
`;

export function buildPaprAuthCallbackPageHtml(
  params: PaprAuthCallbackPageParams | string,
): string {
  const returnTo = typeof params === "string" ? params : params.returnTo;
  const appLabel =
    typeof params === "string"
      ? appLabelFromReturnTo(returnTo)
      : (params.appLabel ?? appLabelFromReturnTo(returnTo));
  const safeUrl = escapePaprAuthHtmlAttribute(returnTo);
  const jsUrl = JSON.stringify(returnTo);
  const headline = appLabel
    ? `Opening ${escapePaprAuthHtml(appLabel)}…`
    : "Opening your app…";
  const buttonLabel = appLabel
    ? `Open ${escapePaprAuthHtml(appLabel)}`
    : "Open app";
  const pageTitle = appLabel
    ? `Opening ${escapePaprAuthHtml(appLabel)}`
    : "Opening your app";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="0;url=${safeUrl}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${pageTitle}</title>
  <style>${PAPR_AUTH_CALLBACK_STYLES}</style>
</head>
<body>
  <main class="papr-auth-callback">
    <div class="papr-auth-callback__card">
      <div class="papr-auth-callback__spinner" role="status" aria-label="Loading"></div>
      <h1 class="papr-auth-callback__title">${headline}</h1>
      <p class="papr-auth-callback__subtitle">You&rsquo;re signed in.</p>
      <div class="papr-auth-callback__fallback" id="papr-auth-fallback" hidden>
        <a class="papr-auth-callback__btn" href="${safeUrl}">${buttonLabel}</a>
      </div>
    </div>
  </main>
  <script>
    setTimeout(function () {
      var el = document.getElementById("papr-auth-fallback");
      if (el) el.hidden = false;
    }, 2500);
    location.replace(${jsUrl});
  </script>
</body>
</html>`;
}

export interface PaprAuthOverlayParams {
  title: string;
  message: string;
  loginUrl?: string;
  showDismiss?: boolean;
}

export function buildPaprAuthOverlayMarkup(params: PaprAuthOverlayParams): {
  overlayClass: string;
  html: string;
} {
  const loginBlock = params.loginUrl
    ? `<a class="papr-auth-overlay__btn" href="${escapePaprAuthHtmlAttribute(params.loginUrl)}">Sign in to Papr</a>`
    : "";
  const dismissBlock =
    params.showDismiss !== false
      ? `<button type="button" class="papr-auth-overlay__dismiss" data-papr-auth-dismiss>Dismiss</button>`
      : "";

  return {
    overlayClass: "papr-auth-overlay",
    html: `<style>${PAPR_AUTH_OVERLAY_STYLES}</style>
<div class="papr-auth-overlay__shell">
  <div class="papr-auth-overlay__left">
    <div class="papr-auth-overlay__form">
      <h2 class="papr-auth-overlay__title">${escapePaprAuthHtml(params.title)}</h2>
      <p class="papr-auth-overlay__message">${escapePaprAuthHtml(params.message)}</p>
      ${loginBlock}
      ${dismissBlock}
    </div>
  </div>
  <div class="papr-auth-overlay__right">
    <div class="papr-auth-overlay__brand">
      <div class="papr-auth__logo-row">${PAPR_LOGO_MARK_SVG}<span class="papr-auth__wordmark">Papr</span></div>
      <div class="papr-auth-overlay__fold">${PAPR_FOLD_SVG}</div>
    </div>
  </div>
</div>`,
  };
}
