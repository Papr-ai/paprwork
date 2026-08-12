/**
 * Cloud App Host — credential requirements gate + web setup wizard.
 */

import type { Express, Request, Response } from "express";

import type { RequiredKeySpec } from "../../../core/types/bundles.js";
import {
  appRequiresUserSignIn,
  getMissingUserKeyNames,
  getUserCredentialKeys,
} from "../../../core/utils/credentialScope.js";
import {
  CLOUD_APP_REQUIREMENTS_FILENAME,
  parseRequirementsFileContent,
} from "../cloudAppRequirements.js";
import type { AppRuntimeRouteAuth } from "./types.js";
import {
  fetchRuntimeVaultKeyNames,
  resolveRuntimeVaultClientKeys,
  syncRuntimeVaultKeys,
} from "./memoryRuntimeClient.js";
import { fetchCachedRuntimeRepoFile } from "./cloudAppHostCache.js";
import {
  resolveCloudAuthReturnToPath,
  resolveCloudAuthReturnToFromRequest,
  cloudAppRootPath,
} from "./cloudAppHostCookies.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

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

function renderCredentialSetupPage(params: {
  namespaceId: string;
  slug: string;
  returnTo: string;
  missing: RequiredKeySpec[];
  error?: string;
}): string {
  const action = setupPath(params.namespaceId, params.slug);
  const fields = params.missing
    .map((spec) => {
      const label = spec.service || spec.name;
      const hint = spec.description
        ? `<p class="hint">${escapeHtml(spec.description)}</p>`
        : "";
      const links: string[] = [];
      if (spec.signupUrl) {
        links.push(
          `<a href="${escapeHtml(spec.signupUrl)}" target="_blank" rel="noopener noreferrer">Get API key</a>`,
        );
      }
      if (spec.docsUrl) {
        links.push(
          `<a href="${escapeHtml(spec.docsUrl)}" target="_blank" rel="noopener noreferrer">Docs</a>`,
        );
      }
      const linkBlock =
        links.length > 0
          ? `<div class="links">${links.join(" · ")}</div>`
          : "";

      return `<label class="field">
  <span class="field-label">${escapeHtml(label)} <code>${escapeHtml(spec.name)}</code></span>
  ${hint}
  ${linkBlock}
  <input type="password" name="${escapeHtml(spec.name)}" autocomplete="off" required placeholder="Paste ${escapeHtml(spec.name)}" />
</label>`;
    })
    .join("\n");

  const errorBlock = params.error
    ? `<p class="error">${escapeHtml(params.error)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Set up credentials</title>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(135deg, #f5f7fb 0%, #eef2ff 100%); color:#111827; padding:24px; box-sizing:border-box; }
    .card { width:100%; max-width:520px; padding:32px 28px; border-radius:16px;
      background:rgba(255,255,255,0.95); box-shadow:0 20px 60px rgba(15,23,42,0.12); }
    h1 { margin:0 0 8px; font-size:24px; }
    .lead { margin:0 0 20px; color:#667085; line-height:1.5; font-size:15px; }
    .field { display:block; margin:0 0 18px; }
    .field-label { display:block; font-weight:600; margin-bottom:6px; font-size:14px; }
    .field-label code { font-weight:500; color:#475467; font-size:12px; margin-left:6px; }
    .hint { margin:0 0 8px; color:#667085; font-size:13px; line-height:1.4; }
    .links { margin:0 0 8px; font-size:13px; }
    .links a { color:#2563eb; text-decoration:none; }
    input { width:100%; box-sizing:border-box; padding:12px 14px; border:1px solid #d0d5dd;
      border-radius:10px; font-size:14px; }
    .btn { margin-top:8px; width:100%; padding:14px 16px; border:none; border-radius:10px;
      background:#2563eb; color:white; font-size:15px; font-weight:600; cursor:pointer; }
    .error { color:#b42318; font-size:14px; margin:0 0 12px; }
    .footnote { margin:16px 0 0; font-size:12px; color:#98a2b3; line-height:1.4; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Set up your credentials</h1>
    <p class="lead">This app needs API keys from <strong>you</strong> before it can run. Keys are stored in your Papr vault — not shared with the app owner.</p>
    ${errorBlock}
    <form method="POST" action="${escapeHtml(action)}">
      <input type="hidden" name="returnTo" value="${escapeHtml(params.returnTo)}" />
      ${fields}
      <button class="btn" type="submit">Save and continue</button>
    </form>
    <p class="footnote">Owner-provided keys (if any) are injected server-side when sandbox jobs run — you only configure keys marked as yours.</p>
  </div>
</body>
</html>`;
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

    const requirements = await loadPublishedAppRequirements(runtimeAuth);
    if (!appRequiresUserSignIn(requirements)) {
      return true;
    }

    const returnTo = resolveCloudAuthReturnToFromRequest(req, {
      namespaceId: runtimeAuth.namespaceId,
      slug: runtimeAuth.slug,
    });
    const loginUrl = `/auth/login?returnTo=${encodeURIComponent(returnTo)}&start=1`;

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

    const vaultKeys = await fetchRuntimeVaultKeyNames(runtimeAuth);
    const missingNames = getMissingUserKeyNames(requirements, vaultKeys);
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
    const loginUrl = `/auth/login?returnTo=${encodeURIComponent(returnTo)}&start=1`;

    if (!runtimeAuth.sessionToken) {
      res.status(401).json({
        error: "authentication_required",
        loginUrl,
      });
      return false;
    }

    const vaultKeys = await fetchRuntimeVaultKeyNames(runtimeAuth);
    const missingNames = getMissingUserKeyNames(requirements, vaultKeys);
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
    const userKeys = getUserCredentialKeys(requirements);
    const vaultKeys = await fetchRuntimeVaultKeyNames(runtimeAuth);
    const missingNames = getMissingUserKeyNames(requirements, vaultKeys);
    const missing = userKeys.filter((spec) => missingNames.includes(spec.name));

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
          namespaceId: runtimeAuth.namespaceId,
          slug: runtimeAuth.slug,
          returnTo,
          missing,
          error,
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
    const vaultKeys = await fetchRuntimeVaultKeyNames(runtimeAuth);
    const missing = getMissingUserKeyNames(requirements, vaultKeys);

    res.json({
      requiresSignIn: appRequiresUserSignIn(requirements),
      ready: missing.length === 0,
      missing,
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
        `/auth/login?returnTo=${encodeURIComponent(returnTo)}&start=1`,
      );
      return;
    }

    const requirements = await loadPublishedAppRequirements(runtimeAuth);
    const userKeys = getUserCredentialKeys(requirements);
    const returnTo = resolveCloudAuthReturnToPath(
      typeof req.body?.returnTo === "string"
        ? req.body.returnTo
        : appRootPath(runtimeAuth.namespaceId, runtimeAuth.slug),
      { namespaceId: runtimeAuth.namespaceId, slug: runtimeAuth.slug },
    );

    const keys: Array<{ name: string; value: string }> = [];
    for (const spec of userKeys) {
      const raw = req.body?.[spec.name];
      if (typeof raw === "string" && raw.trim().length > 0) {
        keys.push({ name: spec.name, value: raw.trim() });
      }
    }

    if (keys.length === 0) {
      const setupUrl = `${setupPath(runtimeAuth.namespaceId, runtimeAuth.slug)}?returnTo=${encodeURIComponent(returnTo)}&error=${encodeURIComponent("Enter at least one API key")}`;
      res.redirect(302, setupUrl);
      return;
    }

    try {
      await syncRuntimeVaultKeys(runtimeAuth, keys);
      const vaultKeys = await fetchRuntimeVaultKeyNames(runtimeAuth);
      const stillMissing = getMissingUserKeyNames(requirements, vaultKeys);
      if (stillMissing.length > 0) {
        const setupUrl = `${setupPath(runtimeAuth.namespaceId, runtimeAuth.slug)}?returnTo=${encodeURIComponent(returnTo)}&error=${encodeURIComponent(`Still missing: ${stillMissing.join(", ")}`)}`;
        res.redirect(302, setupUrl);
        return;
      }
      res.redirect(302, returnTo);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save keys";
      const setupUrl = `${setupPath(runtimeAuth.namespaceId, runtimeAuth.slug)}?returnTo=${encodeURIComponent(returnTo)}&error=${encodeURIComponent(message)}`;
      res.redirect(302, setupUrl);
    }
  }
}
