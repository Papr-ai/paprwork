/**
 * Platform guard for mini-apps on cloud (apps.papr.ai).
 *
 * 1. Pre-flight: blocks POST /api/jobs/run for agent jobs when visitor has no session.
 * 2. Reactive: shows login overlay on 401/403 from /api/* routes.
 *
 * Works for any app that calls fetch('/api/jobs/run', …) — no button attributes needed.
 */

import { buildPaprAuthOverlayMarkup } from "./papr-auth-ui.js";

const API_PREFIX = "/api/";
const OVERLAY_ID = "__papr_auth_overlay__";
const NS_META = "papr-cloud-namespace";
const SLUG_META = "papr-cloud-slug";
const ACCESS_DENIED_DISMISS_COOLDOWN_MS = 60_000;
const AGENT_JOB_TYPES = new Set(["agent", "subagent"]);
const JOB_RUN_PATH = "/api/jobs/run";
const NON_BROWSABLE_PREFIXES = ["/api/", "/auth/", "/__papr__/"];

interface AuthErrorBody {
  error?: string;
  code?: string;
  loginUrl?: string;
  message?: string;
  authenticated?: boolean;
}

interface AuthStatusBody {
  loggedIn?: boolean;
}

interface JobSummary {
  id: string;
  type?: string;
}

type AuthErrorKind = "sign_in" | "no_access" | "key_missing";

let loggedIn = false;
let agentJobIds = new Set<string>();
let jobsCatalogLoaded = false;
let accessDeniedDismissedAt = 0;

function readCloudContextFromPage(): { namespaceId?: string; slug?: string } {
  const namespaceId =
    document.querySelector(`meta[name="${NS_META}"]`)?.getAttribute("content")?.trim() ??
    undefined;
  const slug =
    document.querySelector(`meta[name="${SLUG_META}"]`)?.getAttribute("content")?.trim() ??
    undefined;
  return { namespaceId, slug };
}

function isBrowsableReturnToPath(path: string): boolean {
  if (!path.startsWith("/") || path === "/") {
    return false;
  }
  for (const prefix of NON_BROWSABLE_PREFIXES) {
    if (path === prefix.slice(0, -1) || path.startsWith(prefix)) {
      return false;
    }
  }
  return true;
}

function resolveAuthReturnToPath(): string {
  const path = window.location.pathname;
  if (isBrowsableReturnToPath(path)) {
    return path.endsWith("/") ? path : `${path}/`;
  }

  const { namespaceId, slug } = readCloudContextFromPage();
  if (namespaceId && slug) {
    return `/${namespaceId}/${slug}/`;
  }

  return "/";
}

/** Tab-local app identity — avoids site-wide papr_cloud_* cookie collisions. */
function withCloudContextHeaders(init?: RequestInit): RequestInit | undefined {
  const { namespaceId, slug } = readCloudContextFromPage();
  if (!namespaceId || !slug) {
    return init;
  }

  const headers = new Headers(init?.headers);
  if (!headers.has("X-Papr-Namespace-Id")) {
    headers.set("X-Papr-Namespace-Id", namespaceId);
  }
  if (!headers.has("X-Papr-Slug")) {
    headers.set("X-Papr-Slug", slug);
  }
  return { ...init, headers };
}

function applyCloudContextToFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): { input: RequestInfo | URL; init?: RequestInit } {
  const url = requestUrl(input);
  if (!url.includes(API_PREFIX)) {
    return { input, init };
  }

  const { namespaceId, slug } = readCloudContextFromPage();
  if (!namespaceId || !slug) {
    return { input, init: withCloudContextHeaders(init) };
  }

  if (input instanceof Request) {
    const headers = new Headers(input.headers);
    if (!headers.has("X-Papr-Namespace-Id")) {
      headers.set("X-Papr-Namespace-Id", namespaceId);
    }
    if (!headers.has("X-Papr-Slug")) {
      headers.set("X-Papr-Slug", slug);
    }
    return { input: new Request(input, { headers }), init: undefined };
  }

  return { input, init: withCloudContextHeaders(init) };
}

function loginUrl(returnTo?: string): string {
  const path = returnTo ?? resolveAuthReturnToPath();
  return `/auth/login?returnTo=${encodeURIComponent(path)}`;
}

function normalizeServerLoginUrl(serverLoginUrl: string | undefined): string | undefined {
  if (!serverLoginUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(serverLoginUrl, window.location.origin);
    const returnTo = parsed.searchParams.get("returnTo");
    if (!returnTo || isBrowsableReturnToPath(returnTo)) {
      return serverLoginUrl;
    }
    parsed.searchParams.set("returnTo", resolveAuthReturnToPath());
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return loginUrl();
  }
}

function classifyAuthError(
  status: number,
  body: AuthErrorBody,
): { kind: AuthErrorKind; loginUrl?: string; message: string } | null {
  if (status === 401 || body.error === "authentication_required") {
    return {
      kind: "sign_in",
      loginUrl: normalizeServerLoginUrl(body.loginUrl) ?? loginUrl(),
      message: body.message ?? "Sign in to Papr to use this app.",
    };
  }
  if (status === 403) {
    if (body.code === "job_run_sign_in_required") {
      return {
        kind: "sign_in",
        loginUrl: normalizeServerLoginUrl(body.loginUrl) ?? loginUrl(),
        message:
          body.error ??
          body.message ??
          "Sign in to Papr to run AI agent jobs from this app.",
      };
    }
    if (
      typeof body.error === "string" &&
      body.error.toLowerCase().includes("write not allowed")
    ) {
      return {
        kind: "no_access",
        message:
          body.message ??
          body.error ??
          "This app is read-only. The owner must republish with write access enabled.",
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
        message:
          "This app requires an API key that hasn't been configured yet. Contact the app owner.",
      };
    }
    return {
      kind: "sign_in",
      loginUrl: normalizeServerLoginUrl(body.loginUrl) ?? loginUrl(),
      message: "Sign in to Papr to use this app.",
    };
  }
  return null;
}

function showOverlay(info: { kind: AuthErrorKind; loginUrl?: string; message: string }): void {
  if (document.getElementById(OVERLAY_ID)) return;
  if (
    info.kind === "no_access" &&
    accessDeniedDismissedAt > 0 &&
    Date.now() - accessDeniedDismissedAt < ACCESS_DENIED_DISMISS_COOLDOWN_MS
  ) {
    return;
  }

  const title =
    info.kind === "sign_in"
      ? "Welcome!"
      : info.kind === "no_access"
        ? "Access denied"
        : "Configuration needed";

  const subtitle =
    info.kind === "sign_in"
      ? info.message || "Sign in to Papr to use this cloud app."
      : info.message;

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  const markup = buildPaprAuthOverlayMarkup({
    title,
    message: subtitle,
    loginUrl: info.loginUrl,
    showDismiss: true,
  });
  overlay.className = markup.overlayClass;
  overlay.innerHTML = markup.html;

  const dismiss = overlay.querySelector("[data-papr-auth-dismiss]");
  dismiss?.addEventListener("click", () => {
    overlay.remove();
    if (info.kind === "no_access") {
      accessDeniedDismissedAt = Date.now();
    }
  });

  document.body.appendChild(overlay);
}

function showAgentJobSignInOverlay(): void {
  showOverlay({
    kind: "sign_in",
    loginUrl: loginUrl(),
    message:
      "Sign in to Papr to run AI agent jobs. Invite links can browse and edit data, but agent jobs require a Papr account.",
  });
}

function jobRunSignInResponse(): Response {
  const body: AuthErrorBody = {
    error:
      "Sign in to Papr to run agent jobs from this app. Invite links can use the app UI and backend actions, but AI jobs require a Papr account.",
    code: "job_run_sign_in_required",
    loginUrl: loginUrl(),
  };
  return new Response(JSON.stringify(body), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

function requiresSignInForJob(jobId: string): boolean {
  if (loggedIn) return false;
  if (!jobsCatalogLoaded) return true;
  return agentJobIds.has(jobId);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.pathname;
  return (input as Request).url;
}

function parseJobRunBody(init?: RequestInit): string | null {
  if (!init?.body || typeof init.body !== "string") return null;
  try {
    const parsed = JSON.parse(init.body) as { jobId?: string };
    return typeof parsed.jobId === "string" && parsed.jobId.length > 0
      ? parsed.jobId
      : null;
  } catch {
    return null;
  }
}

function isJobRunRequest(url: string, init?: RequestInit): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "POST") return false;
  const path = url.includes("://") ? new URL(url, window.location.origin).pathname : url;
  return path.includes(JOB_RUN_PATH);
}

const _originalFetch = window.fetch;

async function refreshPlatformAuthState(): Promise<void> {
  try {
    const statusScoped = applyCloudContextToFetch("/auth/status");
    const jobsScoped = applyCloudContextToFetch("/api/jobs/list");
    const [statusRes, jobsRes] = await Promise.all([
      _originalFetch.call(window, statusScoped.input, statusScoped.init),
      _originalFetch.call(window, jobsScoped.input, jobsScoped.init),
    ]);
    if (statusRes.ok) {
      const status = (await statusRes.json()) as AuthStatusBody;
      loggedIn = Boolean(status.loggedIn);
    }
    if (jobsRes.ok) {
      const data = (await jobsRes.json()) as { jobs?: JobSummary[] };
      agentJobIds = new Set(
        (data.jobs ?? [])
          .filter((job) => job.type && AGENT_JOB_TYPES.has(job.type))
          .map((job) => job.id),
      );
      jobsCatalogLoaded = true;
    }
  } catch {
    /* non-fatal — pre-flight stays conservative when catalog missing */
  }
}

window.fetch = async function paprPlatformGuardFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = requestUrl(input);
  const scoped = applyCloudContextToFetch(input, init);

  if (url.includes(API_PREFIX) && isJobRunRequest(url, scoped.init)) {
    const jobId = parseJobRunBody(scoped.init);
    if (jobId && requiresSignInForJob(jobId)) {
      showAgentJobSignInOverlay();
      return jobRunSignInResponse();
    }
  }

  const response = await _originalFetch.call(window, scoped.input, scoped.init);

  if (!url.includes(API_PREFIX)) return response;
  if (response.status !== 401 && response.status !== 403) return response;

  const clone = response.clone();
  try {
    const body = (await clone.json()) as AuthErrorBody;
    const info = classifyAuthError(response.status, body);
    if (info) showOverlay(info);
  } catch {
    showOverlay({
      kind: "sign_in",
      loginUrl: loginUrl(),
      message: "Sign in to Papr to use this app.",
    });
  }

  return response;
};

void refreshPlatformAuthState();
