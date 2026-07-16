/**
 * Platform-level auth guard for mini-apps on cloud (apps.papr.ai).
 *
 * Auto-injected into every published app's index.html. Intercepts fetch()
 * calls to /api/* endpoints and shows a platform-native login overlay when
 * the server returns 401 (not signed in) or 403 (no access).
 *
 * Apps don't need to handle auth errors — this module does it for all of them.
 */

const API_PREFIX = "/api/";
const OVERLAY_ID = "__papr_auth_overlay__";

interface AuthErrorBody {
  error?: string;
  code?: string;
  loginUrl?: string;
  message?: string;
  authenticated?: boolean;
}

type AuthErrorKind = "sign_in" | "no_access" | "key_missing";

function classifyAuthError(
  status: number,
  body: AuthErrorBody,
): { kind: AuthErrorKind; loginUrl?: string; message: string } | null {
  if (status === 401 || body.error === "authentication_required") {
    return {
      kind: "sign_in",
      loginUrl: body.loginUrl ?? `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}&start=1`,
      message: body.message ?? "Sign in to Papr to use this app.",
    };
  }
  if (status === 403) {
    if (body.code === "job_run_sign_in_required") {
      return {
        kind: "sign_in",
        loginUrl: body.loginUrl ?? `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}&start=1`,
        message: body.message ?? "Sign in to Papr to run this action.",
      };
    }
    if (body.authenticated) {
      return {
        kind: "no_access",
        message: body.message ?? "Your Papr account does not have access to this app.",
      };
    }
    if (
      typeof body.error === "string" &&
      (body.error.includes("Missing vault keys") || body.error.includes("not configured"))
    ) {
      return {
        kind: "key_missing",
        message: "This app requires an API key that hasn't been configured yet. Contact the app owner.",
      };
    }
    // Generic 403 without body hints — likely unauthenticated
    return {
      kind: "sign_in",
      loginUrl: `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}&start=1`,
      message: "Sign in to Papr to use this app.",
    };
  }
  return null;
}

function showOverlay(info: { kind: AuthErrorKind; loginUrl?: string; message: string }): void {
  if (document.getElementById(OVERLAY_ID)) return; // already showing

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.45); backdrop-filter: blur(8px);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #fff; border-radius: 16px; padding: 32px 36px;
    max-width: 400px; width: 90%; text-align: center;
    box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  `;

  const icon = info.kind === "sign_in" ? "🔐" : info.kind === "no_access" ? "🚫" : "🔑";
  const title =
    info.kind === "sign_in"
      ? "Sign in required"
      : info.kind === "no_access"
        ? "Access denied"
        : "Configuration needed";

  card.innerHTML = `
    <div style="font-size:48px;margin-bottom:12px">${icon}</div>
    <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#1a1a1a">${title}</h2>
    <p style="margin:0 0 24px;font-size:14px;color:#666;line-height:1.5">${info.message}</p>
  `;

  if (info.loginUrl) {
    const btn = document.createElement("a");
    btn.href = info.loginUrl;
    btn.textContent = "Sign in to Papr";
    btn.style.cssText = `
      display: inline-block; padding: 10px 28px; border-radius: 8px;
      background: #2563eb; color: #fff; text-decoration: none;
      font-size: 14px; font-weight: 500;
    `;
    card.appendChild(btn);
  }

  // Dismiss button (bottom)
  const dismiss = document.createElement("button");
  dismiss.textContent = "Dismiss";
  dismiss.style.cssText = `
    display: block; margin: 16px auto 0; padding: 6px 16px;
    background: none; border: 1px solid #ddd; border-radius: 6px;
    color: #888; font-size: 12px; cursor: pointer;
  `;
  dismiss.onclick = () => overlay.remove();
  card.appendChild(dismiss);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// Monkey-patch fetch to intercept auth errors on /api/* routes
const _originalFetch = window.fetch;

window.fetch = async function paprAuthGuardFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await _originalFetch.call(window, input, init);

  // Only intercept /api/* calls
  const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : (input as Request).url;
  if (!url.includes(API_PREFIX)) return response;

  // Only intercept 401/403
  if (response.status !== 401 && response.status !== 403) return response;

  // Clone so the app can still read the response if it wants to handle it
  const clone = response.clone();
  try {
    const body = (await clone.json()) as AuthErrorBody;
    const info = classifyAuthError(response.status, body);
    if (info) {
      showOverlay(info);
    }
  } catch {
    // Non-JSON 401/403 — show generic sign-in
    showOverlay({
      kind: "sign_in",
      loginUrl: `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}&start=1`,
      message: "Sign in to Papr to use this app.",
    });
  }

  return response;
};
