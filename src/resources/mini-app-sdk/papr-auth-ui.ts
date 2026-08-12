/**
 * Shared Papr sign-in branding for cloud apps (AuthWall-aligned).
 * Used by papr-auth-guard overlay and Cloud App Host auth HTML pages.
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

export const PAPR_AUTH_PAGE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: "SF UI Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #111827;
    background: #F5F5F7;
  }
  .papr-auth {
    display: flex;
    min-height: 100vh;
    width: 100%;
  }
  .papr-auth__left {
    flex: 0 0 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 48px 32px;
    background: rgba(255, 255, 255, 0.72);
    backdrop-filter: blur(40px);
    -webkit-backdrop-filter: blur(40px);
  }
  .papr-auth__form {
    width: 100%;
    max-width: 420px;
    text-align: center;
  }
  .papr-auth__title {
    margin: 0 0 12px;
    font-family: Montserrat, system-ui, -apple-system, sans-serif;
    font-size: 36px;
    font-weight: 700;
    line-height: 1.1;
    color: #111827;
  }
  .papr-auth__subtitle {
    margin: 0 0 32px;
    font-size: 18px;
    line-height: 1.4;
    color: #667085;
  }
  .papr-auth__error {
    margin: 0 0 24px;
    padding: 16px 20px;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.45);
    border-radius: 12px;
    color: #dc2626;
    font-size: 14px;
    line-height: 1.5;
    text-align: left;
  }
  .papr-auth__actions {
    display: flex;
    gap: 12px;
    width: 100%;
    margin-bottom: 20px;
  }
  .papr-auth__btn {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 16px 20px;
    border: none;
    border-radius: 12px;
    font-size: 16px;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
  }
  .papr-auth__btn--primary {
    color: #fff;
    background: ${PAPR_BRAND_BLUE};
    box-shadow: 0 2px 8px rgba(0, 128, 255, 0.2);
  }
  .papr-auth__btn--primary:hover {
    background: ${PAPR_BRAND_BLUE_HOVER};
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 128, 255, 0.3);
  }
  .papr-auth__btn--block {
    display: flex;
    width: 100%;
    margin-bottom: 12px;
  }
  .papr-auth__terms {
    margin: 0;
    font-size: 13px;
    color: #98A2B3;
  }
  .papr-auth__right {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fff;
    position: relative;
    overflow: hidden;
  }
  .papr-auth__brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 48px;
    z-index: 1;
  }
  .papr-auth__logo-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .papr-auth__wordmark {
    font-family: Montserrat, system-ui, -apple-system, sans-serif;
    font-size: 32px;
    font-weight: 700;
    color: #111827;
    letter-spacing: -0.02em;
  }
  .papr-auth__fold {
    width: min(280px, 60vw);
    opacity: 0.95;
  }
  .papr-auth__fold svg {
    width: 100%;
    height: auto;
    display: block;
  }
  .papr-auth__waiting {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 16px 0 8px;
  }
  .papr-auth__spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(0, 128, 255, 0.1);
    border-top-color: ${PAPR_BRAND_BLUE};
    border-radius: 50%;
    animation: papr-auth-spin 0.8s linear infinite;
  }
  @keyframes papr-auth-spin {
    to { transform: rotate(360deg); }
  }
  @media (max-width: 900px) {
    .papr-auth { flex-direction: column; }
    .papr-auth__left, .papr-auth__right { flex: none; min-height: auto; }
    .papr-auth__right { padding: 48px 24px 64px; }
    .papr-auth__fold { width: min(220px, 70vw); }
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1C1C1E; color: #F5F5F7; }
    .papr-auth__left { background: rgba(28, 28, 30, 0.85); }
    .papr-auth__title, .papr-auth__wordmark { color: #F5F5F7; }
    .papr-auth__subtitle, .papr-auth__terms { color: #A1A1AA; }
    .papr-auth__right { background: #111113; }
  }
`;

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
  .papr-auth-overlay__fold { width: min(200px, 80%); }
  .papr-auth-overlay__fold svg { width: 100%; height: auto; display: block; }
  @media (min-width: 720px) {
    .papr-auth-overlay__right { display: flex; }
  }
`;

function paprBrandBlock(): string {
  return `<div class="papr-auth__brand">
    <div class="papr-auth__logo-row">
      ${PAPR_LOGO_MARK_SVG}
      <span class="papr-auth__wordmark">Papr</span>
    </div>
    <div class="papr-auth__fold">${PAPR_FOLD_SVG}</div>
  </div>`;
}

export interface PaprAuthLoginPageParams {
  returnTo: string;
  error?: string;
  headline?: string;
  subtitle?: string;
  pageTitle?: string;
}

export function buildPaprAuthLoginPageHtml(params: PaprAuthLoginPageParams): string {
  const returnTo = encodeURIComponent(params.returnTo);
  const title = escapePaprAuthHtml(params.headline ?? "Welcome!");
  const subtitle = escapePaprAuthHtml(
    params.subtitle ?? "Sign in to Papr to use this cloud app.",
  );
  const pageTitle = escapePaprAuthHtml(params.pageTitle ?? "Sign in to Papr");
  const errorBlock = params.error
    ? `<div class="papr-auth__error" role="alert">${escapePaprAuthHtml(params.error)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${pageTitle}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700&display=swap" rel="stylesheet" />
  <style>${PAPR_AUTH_PAGE_STYLES}</style>
</head>
<body>
  <div class="papr-auth">
    <div class="papr-auth__left">
      <div class="papr-auth__form">
        <h1 class="papr-auth__title">${title}</h1>
        <p class="papr-auth__subtitle">${subtitle}</p>
        ${errorBlock}
        <div class="papr-auth__actions">
          <a class="papr-auth__btn papr-auth__btn--primary" href="/auth/login?returnTo=${returnTo}&mode=login&start=1">Sign in</a>
          <a class="papr-auth__btn papr-auth__btn--primary" href="/auth/login?returnTo=${returnTo}&mode=signup&start=1">Create account</a>
        </div>
        <p class="papr-auth__terms">By continuing you agree to the terms of use</p>
      </div>
    </div>
    <div class="papr-auth__right">${paprBrandBlock()}</div>
  </div>
</body>
</html>`;
}

export function buildPaprAuthCallbackPageHtml(returnTo: string): string {
  const safeUrl = escapePaprAuthHtmlAttribute(returnTo);
  const jsUrl = JSON.stringify(returnTo);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="0;url=${safeUrl}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Signing you in…</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700&display=swap" rel="stylesheet" />
  <style>${PAPR_AUTH_PAGE_STYLES}</style>
</head>
<body>
  <div class="papr-auth">
    <div class="papr-auth__left">
      <div class="papr-auth__form">
        <h1 class="papr-auth__title">Signed in!</h1>
        <p class="papr-auth__subtitle">Taking you back to your app…</p>
        <div class="papr-auth__waiting">
          <div class="papr-auth__spinner" aria-hidden="true"></div>
        </div>
        <a class="papr-auth__btn papr-auth__btn--primary papr-auth__btn--block" href="${safeUrl}">Continue to app</a>
      </div>
    </div>
    <div class="papr-auth__right">${paprBrandBlock()}</div>
  </div>
  <script>location.replace(${jsUrl});</script>
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
