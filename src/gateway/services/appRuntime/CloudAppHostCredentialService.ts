/**
 * Cloud App Host — credential requirements gate + web setup wizard.
 */

import type { Express, Request, Response } from "express";

import type { RequiredKeySpec } from "../../../core/types/bundles.js";
import {
  appRequiresUserSignIn,
  getUserCredentialKeys,
  normalizeCredentialRequirements,
} from "../../../core/utils/credentialScope.js";
import { renderCredentialSetupPage } from "./cloudAppCredentialSetupPage.js";
import {
  CLOUD_APP_REQUIREMENTS_FILENAME,
  parseRequirementsFileContent,
} from "../cloudAppRequirements.js";
import type { AppRuntimeRouteAuth } from "./types.js";
import {
  fetchRuntimeVaultKeyNames,
  resolveMissingRuntimeVaultKeyNames,
  resolveRuntimeVaultClientKeys,
  syncRuntimeVaultKeys,
} from "./memoryRuntimeClient.js";
import { fetchCachedRuntimeRepoFile } from "./cloudAppHostCache.js";
import {
  resolveCloudAuthReturnToPath,
  resolveCloudAuthReturnToFromRequest,
  cloudAppRootPath,
} from "./cloudAppHostCookies.js";

export async function loadPublishedAppRequirements(
  runtimeAuth: AppRuntimeRouteAuth,
): Promise<RequiredKeySpec[]> {
  const file = await fetchCachedRuntimeRepoFile(
    runtimeAuth,
    CLOUD_APP_REQUIREMENTS_FILENAME,
  );
  if (!file) {
    return [];
  }
  return parseRequirementsFileContent(file.content);
}

function appRootPath(namespaceId: string, slug: string): string {
  return cloudAppRootPath(namespaceId, slug);
}

function setupPath(namespaceId: string, slug: string): string {
  return `${appRootPath(namespaceId, slug)}credentials/setup`;
}

/**
 * Files the credential setup redirect must never answer for.
 *
 * dist/cards/* is what Claude loads (cards.json to list the app, {view}.html to show it).
 * They're static build output, not the app's UI, and the MCP server reads them with
 * redirect: "manual": a 302 to credentials/setup made it drop the app from Claude without
 * a trace (any app with a per-user key, e.g. LinkedIn Outreach's LINKEDIN_LI_AT). Read
 * access is still checked before this; actions a card runs keep their own credential
 * check (ensureCredentialsForApi → 422 with setupUrl), so a card can say what's missing.
 */
export function isCredentialGateExemptPath(requestedPath: string): boolean {
  return requestedPath.startsWith("dist/cards/") && !requestedPath.includes("..");
}

async function missingUserCredentialNames(
  runtimeAuth: AppRuntimeRouteAuth,
  requirements: RequiredKeySpec[],
): Promise<string[]> {
  const userKeys = getUserCredentialKeys(requirements);
  return resolveMissingRuntimeVaultKeyNames(
    runtimeAuth,
    userKeys.map((spec) => spec.name),
  );
}

/** Visitor chose "Skip for now": open the app; features that need a key still say so. */
const CREDENTIAL_SKIP_COOKIE = "papr_cred_skip";
const CREDENTIAL_SKIP_MAX_AGE_SEC = 60 * 60 * 24 * 30;

function skipCookiePath(namespaceId: string, slug: string): string {
  return appRootPath(namespaceId, slug);
}

export function hasCredentialSkipCookie(cookieHeader: string | undefined): boolean {
  return Boolean(
    cookieHeader
      ?.split(";")
      .some((part) => part.trim() === `${CREDENTIAL_SKIP_COOKIE}=1`),
  );
}

function buildCredentialSkipCookie(
  namespaceId: string,
  slug: string,
  secure: boolean,
): string {
  return (
    `${CREDENTIAL_SKIP_COOKIE}=1; Path=${skipCookiePath(namespaceId, slug)}; HttpOnly; ` +
    `SameSite=${secure ? "None" : "Lax"}; Max-Age=${CREDENTIAL_SKIP_MAX_AGE_SEC}${secure ? "; Secure" : ""}`
  );
}

function requestIsSecure(req: Request): boolean {
  return req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
}

/** "linkedin-outreach" → "Linkedin Outreach" (the page has no catalog title). */
function appTitleFromSlug(slug: string): string {
  return (
    slug
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || slug
  );
}

/** Keys each visitor brings, including optional ones (shown, never forced). */
function allUserCredentialKeys(requirements: RequiredKeySpec[]): RequiredKeySpec[] {
  return normalizeCredentialRequirements(requirements).filter(
    (spec) => spec.credentialScope === "user",
  );
}

export class CloudAppHostCredentialService {
  constructor(
    private readonly resolveRuntimeAuth: (
      req: Request,
    ) => AppRuntimeRouteAuth | null,
  ) {}

  registerRoutes(app: Express): void {
    app.get(
      "/:namespaceId/:slug/api/credentials/status",
      (req, res) => void this.handleStatus(req, res),
    );
    app.post(
      "/:namespaceId/:slug/api/credentials/client-keys",
      (req, res) => void this.handleClientKeys(req, res),
    );
    app.post(
      "/:namespaceId/:slug/api/credentials/setup",
      (req, res) => void this.handleSetupJson(req, res),
    );
    app.post(
      "/:namespaceId/:slug/credentials/setup",
      (req, res) => void this.handleSetupForm(req, res),
    );
  }

  async ensureCredentialsForApp(
    req: Request,
    res: Response,
    runtimeAuth: AppRuntimeRouteAuth,
    requestedPath: string,
    canRead: boolean,
  ): Promise<boolean> {
    if (!canRead) {
      return true;
    }

    if (isCredentialGateExemptPath(requestedPath)) {
      return true;
    }

    const requirements = await loadPublishedAppRequirements(runtimeAuth);
    if (!appRequiresUserSignIn(requirements)) {
      return true;
    }

    const returnTo = resolveCloudAuthReturnToFromRequest(req, {
      namespaceId: runtimeAuth.namespaceId,
      slug: runtimeAuth.slug,
    });
    const loginUrl = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

    if (!runtimeAuth.sessionToken) {
      if (
        requestedPath === "credentials/setup" ||
        requestedPath.startsWith("api/credentials/")
      ) {
        res.redirect(302, loginUrl);
        return false;
      }
      res.redirect(302, loginUrl);
      return false;
    }

    if (
      requestedPath === "credentials/setup" ||
      requestedPath.startsWith("api/credentials/")
    ) {
      return true;
    }

    if (hasCredentialSkipCookie(req.headers.cookie)) {
      return true;
    }

    const missingNames = await missingUserCredentialNames(
      runtimeAuth,
      requirements,
    );
    if (missingNames.length === 0) {
      return true;
    }

    const setupUrl = `${setupPath(runtimeAuth.namespaceId, runtimeAuth.slug)}?returnTo=${encodeURIComponent(returnTo)}`;
    res.redirect(302, setupUrl);
    return false;
  }

  /** JSON API variant — for /api/bash/run (no redirects). */
  async ensureCredentialsForApi(
    req: Request,
    res: Response,
    runtimeAuth: AppRuntimeRouteAuth,
  ): Promise<boolean> {
    const requirements = await loadPublishedAppRequirements(runtimeAuth);
    if (!appRequiresUserSignIn(requirements)) {
      return true;
    }

    const returnTo = resolveCloudAuthReturnToFromRequest(req, {
      namespaceId: runtimeAuth.namespaceId,
      slug: runtimeAuth.slug,
    });
    const loginUrl = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

    if (!runtimeAuth.sessionToken) {
      res.status(401).json({
        error: "authentication_required",
        loginUrl,
      });
      return false;
    }

    const missingNames = await missingUserCredentialNames(
      runtimeAuth,
      requirements,
    );
    if (missingNames.length === 0) {
      return true;
    }

    const setupUrl = `${setupPath(runtimeAuth.namespaceId, runtimeAuth.slug)}?returnTo=${encodeURIComponent(returnTo)}`;
    res.status(422).json({
      error: "credentials_required",
      missing: missingNames,
      setupUrl,
    });
    return false;
  }

  async serveCredentialSetupPage(
    req: Request,
    res: Response,
    runtimeAuth: AppRuntimeRouteAuth,
  ): Promise<void> {
    const requirements = await loadPublishedAppRequirements(runtimeAuth);
    const userKeys = allUserCredentialKeys(requirements);
    const missingNames = await resolveMissingRuntimeVaultKeyNames(
      runtimeAuth,
      userKeys.map((spec) => spec.name),
    );
    // Required first: those are what the app needs to work at all.
    const missing = userKeys
      .filter((spec) => missingNames.includes(spec.name))
      .sort((a, b) => Number(a.required === false) - Number(b.required === false));

    const returnTo = resolveCloudAuthReturnToPath(
      typeof req.query.returnTo === "string"
        ? req.query.returnTo
        : appRootPath(runtimeAuth.namespaceId, runtimeAuth.slug),
      { namespaceId: runtimeAuth.namespaceId, slug: runtimeAuth.slug },
    );

    if (missing.length === 0) {
      res.redirect(302, returnTo);
      return;
    }

    const error =
      typeof req.query.error === "string" ? req.query.error : undefined;

    res
      .status(200)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .send(
        renderCredentialSetupPage({
          action: setupPath(runtimeAuth.namespaceId, runtimeAuth.slug),
          appTitle: appTitleFromSlug(runtimeAuth.slug),
          returnTo,
          missing,
          error,
          statusUrl: `/${encodeURIComponent(runtimeAuth.namespaceId)}/${encodeURIComponent(runtimeAuth.slug)}/api/credentials/status`,
        }),
      );
  }


  private async handleClientKeys(req: Request, res: Response): Promise<void> {
    const runtimeAuth = this.resolveRuntimeAuth(req);
    if (!runtimeAuth) {
      res.status(403).json({ error: "invalid_runtime_context" });
      return;
    }

    const body = req.body as { names?: string[] };
    try {
      const result = await resolveRuntimeVaultClientKeys(runtimeAuth, {
        keyNames: body.names,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  private async handleStatus(req: Request, res: Response): Promise<void> {
    const runtimeAuth = this.resolveRuntimeAuth(req);
    if (!runtimeAuth?.sessionToken) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }

    const requirements = await loadPublishedAppRequirements(runtimeAuth);
    const missing = await missingUserCredentialNames(runtimeAuth, requirements);
    const vaultKeys = await fetchRuntimeVaultKeyNames(runtimeAuth);

    res.json({
      requiresSignIn: appRequiresUserSignIn(requirements),
      ready: missing.length === 0,
      missing,
      vaultKeyNames: vaultKeys,
      userKeyCount: getUserCredentialKeys(requirements).length,
    });
  }

  private async handleSetupJson(req: Request, res: Response): Promise<void> {
    const runtimeAuth = this.resolveRuntimeAuth(req);
    if (!runtimeAuth?.sessionToken) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }

    const body = req.body as { keys?: Array<{ name: string; value: string }> };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (keys.length === 0) {
      res.status(400).json({ error: "keys array is required" });
      return;
    }

    try {
      const result = await syncRuntimeVaultKeys(runtimeAuth, keys);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  private async handleSetupForm(req: Request, res: Response): Promise<void> {
    const runtimeAuth = this.resolveRuntimeAuth(req);
    if (!runtimeAuth?.sessionToken) {
      const returnTo = resolveCloudAuthReturnToFromRequest(req, runtimeAuth
        ? { namespaceId: runtimeAuth.namespaceId, slug: runtimeAuth.slug }
        : undefined);
      res.redirect(
        302,
        `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
      );
      return;
    }

    const requirements = await loadPublishedAppRequirements(runtimeAuth);
    const userKeys = allUserCredentialKeys(requirements);
    const returnTo = resolveCloudAuthReturnToPath(
      typeof req.body?.returnTo === "string"
        ? req.body.returnTo
        : appRootPath(runtimeAuth.namespaceId, runtimeAuth.slug),
      { namespaceId: runtimeAuth.namespaceId, slug: runtimeAuth.slug },
    );
    const skipCookie = buildCredentialSkipCookie(
      runtimeAuth.namespaceId,
      runtimeAuth.slug,
      requestIsSecure(req),
    );
    const skipping = req.body?.skip === "1";

    const keys: Array<{ name: string; value: string }> = [];
    for (const spec of userKeys) {
      const raw = req.body?.[spec.name];
      if (typeof raw === "string" && raw.trim().length > 0) {
        keys.push({ name: spec.name, value: raw.trim() });
      }
    }

    if (keys.length === 0) {
      if (skipping) {
        res.append("Set-Cookie", skipCookie);
        res.redirect(302, returnTo);
        return;
      }
      const setupUrl = `${setupPath(runtimeAuth.namespaceId, runtimeAuth.slug)}?returnTo=${encodeURIComponent(returnTo)}&error=${encodeURIComponent("Paste a key, or choose Skip for now.")}`;
      res.redirect(302, setupUrl);
      return;
    }

    try {
      await syncRuntimeVaultKeys(runtimeAuth, keys);
      const stillMissing = await missingUserCredentialNames(
        runtimeAuth,
        requirements,
      );
      if (stillMissing.length > 0 && !skipping) {
        const labels = userKeys
          .filter((spec) => stillMissing.includes(spec.name))
          .map((spec) => spec.service || spec.name);
        const setupUrl = `${setupPath(runtimeAuth.namespaceId, runtimeAuth.slug)}?returnTo=${encodeURIComponent(returnTo)}&error=${encodeURIComponent(`Saved. Still needed: ${labels.join(", ")} — add it or skip for now.`)}`;
        res.redirect(302, setupUrl);
        return;
      }
      if (stillMissing.length > 0) {
        res.append("Set-Cookie", skipCookie);
      }
      res.redirect(302, returnTo);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save keys";
      const setupUrl = `${setupPath(runtimeAuth.namespaceId, runtimeAuth.slug)}?returnTo=${encodeURIComponent(returnTo)}&error=${encodeURIComponent(message)}`;
      res.redirect(302, setupUrl);
    }
  }
}
