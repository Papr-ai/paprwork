/**
 * Papr web login for Cloud App Host (Auth0 PKCE + HttpOnly session cookies).
 */

import type { Express, Request, Response } from "express";
import {
  buildAuth0AuthorizeUrl,
  decodeIdToken,
  exchangeCodeForTokens,
  extractParseSessionFromIdToken,
  formatAuth0CallbackError,
  generateAuthState,
  generateCodeChallenge,
  generateCodeVerifier,
  getCloudAppHostAuth0Config,
  type PaprAuthMode,
} from "../../../core/utils/paprAuth0Pkce.js";
import {
  buildAuthPendingCookie,
  buildSessionCookie,
  clearAuthPendingCookie,
  clearLegacySessionCookies,
  getSessionCookieDiagnostics,
  readAuthPendingCookie,
  readSessionTokenFromCookie,
  sanitizeReturnToPath,
} from "./cloudAppHostCookies.js";

function requestIsSecure(req: Request): boolean {
  return req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
}

function publicBaseUrl(req: Request): string {
  const configured = process.env.PAPR_CLOUD_APP_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const host = req.get("host") ?? "localhost:8787";
  return `${requestIsSecure(req) ? "https" : "http"}://${host}`;
}

function renderLoginPage(params: {
  returnTo: string;
  error?: string;
  headline?: string;
  subtitle?: string;
}): string {
  const returnTo = encodeURIComponent(params.returnTo);
  const errorBlock = params.error
    ? `<p style="color:#b42318;margin:0 0 16px;font-size:14px;">${escapeHtml(params.error)}</p>`
    : "";
  const title = escapeHtml(params.headline ?? "Sign in to Papr");
  const subtitle = escapeHtml(
    params.subtitle ?? "Sign in to access this cloud mini-app.",
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in to Papr</title>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(135deg, #f5f7fb 0%, #eef2ff 100%); color:#111827; }
    .card { width:100%; max-width:420px; padding:40px 32px; border-radius:16px;
      background:rgba(255,255,255,0.92); box-shadow:0 20px 60px rgba(15,23,42,0.12); text-align:center; }
    h1 { margin:0 0 8px; font-size:28px; }
    p { margin:0 0 24px; color:#667085; line-height:1.5; }
    .btn { display:block; width:100%; box-sizing:border-box; margin:0 0 12px; padding:14px 16px;
      border:none; border-radius:10px; font-size:15px; font-weight:600; cursor:pointer; text-decoration:none; }
    .btn-primary { background:#2563eb; color:white; }
    .btn-secondary { background:#eef2ff; color:#1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${subtitle}</p>
    ${errorBlock}
    <a class="btn btn-primary" href="/auth/login?returnTo=${returnTo}&mode=login&start=1">Sign in</a>
    <a class="btn btn-secondary" href="/auth/login?returnTo=${returnTo}&mode=signup&start=1">Create account</a>
  </div>
</body>
</html>`;
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function renderAuthCallbackLandingPage(returnTo: string): string {
  const safeUrl = escapeHtmlAttribute(returnTo);
  const jsUrl = JSON.stringify(returnTo);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="0;url=${safeUrl}" />
  <title>Signing you in…</title>
</head>
<body>
  <p>Signing you in…</p>
  <script>location.replace(${jsUrl});</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export class CloudAppHostAuthService {
  registerRoutes(app: Express): void {
    app.get("/auth/login", (req, res) => this.handleLogin(req, res));
    app.get("/auth/callback", (req, res) => void this.handleCallback(req, res));
    app.get("/auth/logout", (req, res) => this.handleLogout(req, res));
    app.get("/auth/status", (req, res) => this.handleStatus(req, res));
  }

  getSessionToken(req: Request): string | undefined {
    return readSessionTokenFromCookie(req.headers.cookie);
  }

  private handleStatus(req: Request, res: Response): void {
    const sessionToken = this.getSessionToken(req);
    const diagnostics = getSessionCookieDiagnostics(req.headers.cookie);
    const body: Record<string, unknown> = {
      loggedIn: Boolean(sessionToken),
      ...diagnostics,
    };
    if (
      diagnostics.sessionCookiePresent &&
      !diagnostics.sessionCookieValid &&
      !sessionToken
    ) {
      body.hint =
        "A session cookie was sent but could not be verified. Try signing out and in again. " +
        "If it keeps happening, the server signing key may have rotated.";
    }
    res.json(body);
  }

  private handleLogin(req: Request, res: Response): void {
    const secure = requestIsSecure(req);
    const returnTo = sanitizeReturnToPath(
      typeof req.query.returnTo === "string" ? req.query.returnTo : "/",
    );
    const mode: PaprAuthMode =
      req.query.mode === "signup" ? "signup" : "login";
    const shouldStart = req.query.start === "1";
    const existingSession = this.getSessionToken(req);

    // Already signed in — skip Auth0 (prevents sign-in loop when access is still denied).
    if (existingSession) {
      if (shouldStart || returnTo !== "/") {
        res.redirect(302, returnTo);
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        renderLoginPage({
          returnTo,
          headline: "Already signed in",
          subtitle:
            "You are already signed in to apps.papr.ai. If this app still will not open, you need the invite link or team access — not another sign-in.",
        }),
      );
      return;
    }

    if (!shouldStart) {
      const error =
        typeof req.query.error === "string" ? req.query.error : undefined;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        renderLoginPage({
          returnTo,
          error,
          headline: "Sign in required",
          subtitle:
            "You are not signed in to apps.papr.ai. Sign in with your Papr account to access team-shared apps.",
        }),
      );
      return;
    }

    const config = getCloudAppHostAuth0Config(publicBaseUrl(req));
    const state = generateAuthState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    res.append(
      "Set-Cookie",
      buildAuthPendingCookie({ state, codeVerifier, returnTo }, secure),
    );

    const authUrl = buildAuth0AuthorizeUrl(config, {
      state,
      codeChallenge,
      mode,
    });
    res.redirect(302, authUrl.toString());
  }

  private async handleCallback(req: Request, res: Response): Promise<void> {
    const secure = requestIsSecure(req);
    const error = typeof req.query.error === "string" ? req.query.error : undefined;
    if (error) {
      const message = formatAuth0CallbackError(
        error,
        typeof req.query.error_description === "string"
          ? req.query.error_description
          : null,
      );
      res.redirect(302, `/auth/login?error=${encodeURIComponent(message)}`);
      return;
    }

    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const pending = readAuthPendingCookie(req.headers.cookie);

    const existingSession = this.getSessionToken(req);

    if (!code || !state) {
      res.redirect(
        302,
        `/auth/login?error=${encodeURIComponent("Login session expired. Please try again.")}`,
      );
      return;
    }

    if (!pending || pending.state !== state) {
      // Callback hit twice, pending expired, or signing key mismatch — don't strand users
      // who already have a valid session from a prior successful login.
      if (existingSession) {
        res.redirect(302, sanitizeReturnToPath(pending?.returnTo ?? "/"));
        return;
      }
      res.redirect(
        302,
        `/auth/login?error=${encodeURIComponent("Login session expired. Please try again.")}`,
      );
      return;
    }

    try {
      const config = getCloudAppHostAuth0Config(publicBaseUrl(req));
      const tokens = await exchangeCodeForTokens(config, code, pending.codeVerifier);
      if (!tokens.id_token) {
        throw new Error("No ID token received from Auth0");
      }

      const claims = extractParseSessionFromIdToken(decodeIdToken(tokens.id_token));
      const returnTo = sanitizeReturnToPath(pending.returnTo);

      for (const clearCookie of clearLegacySessionCookies(secure)) {
        res.append("Set-Cookie", clearCookie);
      }
      res.append("Set-Cookie", buildSessionCookie(claims.sessionToken, secure));
      res.append("Set-Cookie", clearAuthPendingCookie(secure));
      // 200 + client redirect: browsers reliably persist Set-Cookie vs 302 OAuth chains.
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderAuthCallbackLandingPage(returnTo));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      res.append("Set-Cookie", clearAuthPendingCookie(secure));
      res.redirect(302, `/auth/login?error=${encodeURIComponent(message)}`);
    }
  }

  private handleLogout(req: Request, res: Response): void {
    const secure = requestIsSecure(req);
    const returnTo = sanitizeReturnToPath(
      typeof req.query.returnTo === "string" ? req.query.returnTo : "/",
    );
    for (const clearCookie of clearLegacySessionCookies(secure)) {
      res.append("Set-Cookie", clearCookie);
    }
    res.redirect(302, returnTo);
  }
}
