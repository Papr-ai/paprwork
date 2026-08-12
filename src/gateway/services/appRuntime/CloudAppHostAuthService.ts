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
  buildPaprAuthCallbackPageHtml,
  buildPaprAuthLoginPageHtml,
} from "../../../resources/mini-app-sdk/papr-auth-ui.js";
import { parseCookieHeader } from "./cloudAppHostContext.js";
import {
  buildAuthPendingCookie,
  buildSessionCookie,
  clearAuthPendingCookie,
  clearLegacySessionCookies,
  getSessionCookieDiagnostics,
  readAuthPendingCookie,
  readCloudAppSessionFromCookie,
  resolveCloudAuthReturnToPath,
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

function resolveReturnToFromRequest(req: Request, candidate?: string): string {
  const cookies = parseCookieHeader(req.headers.cookie);
  return resolveCloudAuthReturnToPath(candidate, {
    namespaceId: cookies.papr_cloud_ns,
    slug: cookies.papr_cloud_slug,
  });
}

export class CloudAppHostAuthService {
  registerRoutes(app: Express): void {
    app.get("/auth/login", (req, res) => this.handleLogin(req, res));
    app.get("/auth/callback", (req, res) => void this.handleCallback(req, res));
    app.get("/auth/logout", (req, res) => this.handleLogout(req, res));
    app.get("/auth/status", (req, res) => this.handleStatus(req, res));
  }

  getSessionToken(req: Request): string | undefined {
    return readCloudAppSessionFromCookie(req.headers.cookie)?.sessionToken;
  }

  getExternalUserId(req: Request): string | undefined {
    return readCloudAppSessionFromCookie(req.headers.cookie)?.externalUserId;
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
    const returnTo = resolveReturnToFromRequest(
      req,
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
        buildPaprAuthLoginPageHtml({
          returnTo,
          headline: "Already signed in",
          subtitle:
            "You are already signed in to apps.papr.ai. If this app still will not open, you need the invite link or team access — not another sign-in.",
          pageTitle: "Already signed in — Papr",
        }),
      );
      return;
    }

    if (!shouldStart) {
      const error =
        typeof req.query.error === "string" ? req.query.error : undefined;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        buildPaprAuthLoginPageHtml({
          returnTo,
          error,
          headline: "Welcome!",
          subtitle:
            "Sign in to Papr to use this cloud app. Team-shared apps require a Papr account.",
          pageTitle: "Sign in to Papr",
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
        res.redirect(302, resolveReturnToFromRequest(req, pending?.returnTo ?? "/"));
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
      const returnTo = resolveReturnToFromRequest(req, pending.returnTo);

      for (const clearCookie of clearLegacySessionCookies(secure)) {
        res.append("Set-Cookie", clearCookie);
      }
      res.append("Set-Cookie", buildSessionCookie(claims.sessionToken, secure, claims.objectId));
      res.append("Set-Cookie", clearAuthPendingCookie(secure));
      // 200 + client redirect: browsers reliably persist Set-Cookie vs 302 OAuth chains.
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(buildPaprAuthCallbackPageHtml(returnTo));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      res.append("Set-Cookie", clearAuthPendingCookie(secure));
      res.redirect(302, `/auth/login?error=${encodeURIComponent(message)}`);
    }
  }

  private handleLogout(req: Request, res: Response): void {
    const secure = requestIsSecure(req);
    const returnTo = resolveReturnToFromRequest(
      req,
      typeof req.query.returnTo === "string" ? req.query.returnTo : "/",
    );
    for (const clearCookie of clearLegacySessionCookies(secure)) {
      res.append("Set-Cookie", clearCookie);
    }
    res.redirect(302, returnTo);
  }
}
