/**
 * Papr Login IPC Handlers
 *
 * Handles OAuth PKCE flow directly with Auth0 for Papr authentication.
 * Replaces the old dashboard-redirect flow with a direct OAuth flow.
 *
 * Flow:
 *   1. Generate PKCE code_verifier + code_challenge
 *   2. Open Auth0 /authorize in system browser
 *   3. Auth0 redirects to papr://auth/callback?code=xxx
 *   4. Exchange code for tokens via Auth0 /oauth/token
 *   5. Decode ID token to extract Parse sessionToken + objectId
 *   6. Call Parse GraphQL to provision org/namespace/API key (if first login)
 *   7. Store the API key as PAPR_API_KEY in keychain
 */

import { ipcMain, BrowserWindow, shell } from "electron";
import { CustomKeysStorage, SettingsStorage } from "../../core/storage/index.js";
import { invalidateKeyCache } from "./customKeys.js";
import {
  fetchWorkspaceMembers,
  sendWorkspaceInvite,
} from "./paprWorkspaceTeam.js";
import * as crypto from "crypto";
import os from "node:os";
import path from "node:path";

/**
 * Sync Papr profile fields to gateway settings file so the gateway process
 * (including CodeIndexerService) can use it as user_id on memory writes.
 */
export async function syncProfileToGatewaySettings(
  email: string,
  userId: string,
  displayName?: string,
  imageUrl?: string,
  organization?: string,
): Promise<void> {
  try {
    const fsP = await import("fs/promises");
    const pathM = await import("path");
    const osM = await import("os");
    const { invalidatePaprUserIdCache } = await import(
      "../../gateway/utils/paprUserId.js"
    );
    const settingsPath = pathM.join(osM.homedir(), "Papr", "data", "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      const raw = await fsP.readFile(settingsPath, "utf-8");
      settings = JSON.parse(raw);
    } catch { /* file may not exist yet */ }
    if (!settings.profile || typeof settings.profile !== "object") {
      settings.profile = { name: "", email: "", imageUrl: "" };
    }
    const profile = settings.profile as Record<string, string>;
    profile.email = email;
    profile.paprUserId = userId;
    if (displayName?.trim()) {
      profile.name = displayName.trim();
    }
    if (imageUrl?.trim()) {
      profile.imageUrl = imageUrl.trim();
    }
    if (organization?.trim()) {
      profile.organization = organization.trim();
    }
    await fsP.mkdir(pathM.dirname(settingsPath), { recursive: true });
    await fsP.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    invalidatePaprUserIdCache();
    console.log(`[PaprLogin] Synced profile to gateway settings: ${email} (${userId})`);
  } catch (e) {
    console.warn("[PaprLogin] Failed to sync profile to gateway settings:", e);
  }
}

/** Remove Papr user id from gateway settings after logout. */
export async function clearPaprUserIdFromGatewaySettings(): Promise<void> {
  try {
    const fsP = await import("fs/promises");
    const pathM = await import("path");
    const osM = await import("os");
    const { invalidatePaprUserIdCache } = await import(
      "../../gateway/utils/paprUserId.js"
    );
    const settingsPath = pathM.join(osM.homedir(), "Papr", "data", "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      const raw = await fsP.readFile(settingsPath, "utf-8");
      settings = JSON.parse(raw);
    } catch {
      return;
    }
    if (!settings.profile || typeof settings.profile !== "object") {
      return;
    }
    const profile = settings.profile as Record<string, string>;
    delete profile.paprUserId;
    await fsP.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    invalidatePaprUserIdCache();
    console.log("[PaprLogin] Cleared paprUserId from gateway settings");
  } catch (e) {
    console.warn("[PaprLogin] Failed to clear paprUserId from gateway settings:", e);
  }
}

// Auth0 configuration — env vars for dev, defaults for prod
// Remove https:// prefix if present (to avoid double https in URLs)
const AUTH0_DOMAIN = (process.env.AUTH0_DOMAIN || "papr.auth0.com").replace(/^https?:\/\//, "");
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID || "asVGkVRkRAxYvtQadqivntIRjB4D1Iur";
const AUTH0_REDIRECT_URI = "papr://auth/callback";
const AUTH0_SCOPE = "openid profile email offline_access";

console.log("[PaprLogin] Configuration:");
console.log(`  AUTH0_DOMAIN: ${AUTH0_DOMAIN}`);
console.log(`  AUTH0_CLIENT_ID: ${AUTH0_CLIENT_ID}`);
console.log(`  ENV AUTH0_DOMAIN: ${process.env.AUTH0_DOMAIN || "(not set)"}`);
console.log(`  ENV AUTH0_CLIENT_ID: ${process.env.AUTH0_CLIENT_ID || "(not set)"}`);

// Parse Server configuration
const PARSE_GRAPHQL_URL = process.env.PARSE_GRAPHQL_URL || "https://server.papr.ai/graphql";
const PARSE_APP_ID = process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";

export type PaprAuthMode = "login" | "signup";
export type PaprLoginSource = "auth_wall" | "settings" | "unknown";

interface PaprLoginState {
  pendingState?: string;
  codeVerifier?: string;
  mode?: PaprAuthMode;
  source?: PaprLoginSource;
}

interface PersistedPkceState {
  pendingState: string;
  codeVerifier: string;
  mode?: PaprAuthMode;
  source?: PaprLoginSource;
  createdAt: string;
}

const loginState: PaprLoginState = {};
const PKCE_TTL_MS = 10 * 60 * 1000;

type LoginTelemetryTracker = (
  eventName: string,
  properties?: Record<string, unknown>,
) => void;

let trackLoginEvent: LoginTelemetryTracker | undefined;

function getPkceStatePath(): string {
  return path.join(os.homedir(), "Papr", "data", "papr-auth-pkce.json");
}

async function persistPkceState(state: PersistedPkceState): Promise<void> {
  const fs = await import("fs/promises");
  const filePath = getPkceStatePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

async function loadPersistedPkceState(): Promise<PersistedPkceState | null> {
  const fs = await import("fs/promises");
  const filePath = getPkceStatePath();
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedPkceState;
    if (
      !parsed.pendingState ||
      !parsed.codeVerifier ||
      !parsed.createdAt ||
      Date.now() - new Date(parsed.createdAt).getTime() > PKCE_TTL_MS
    ) {
      await clearPersistedPkceState();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function clearPersistedPkceState(): Promise<void> {
  const fs = await import("fs/promises");
  const filePath = getPkceStatePath();
  try {
    await fs.unlink(filePath);
  } catch {
    // File may not exist
  }
}

function clearInMemoryPkceState(): void {
  loginState.pendingState = undefined;
  loginState.codeVerifier = undefined;
  loginState.mode = undefined;
  loginState.source = undefined;
}

async function restorePkceFromDisk(): Promise<void> {
  const persisted = await loadPersistedPkceState();
  if (!persisted) {
    return;
  }
  loginState.pendingState = persisted.pendingState;
  loginState.codeVerifier = persisted.codeVerifier;
  loginState.mode = persisted.mode;
  loginState.source = persisted.source;
}

async function hydratePkceForCallback(state: string | null): Promise<void> {
  if (
    loginState.codeVerifier &&
    loginState.pendingState &&
    (!state || loginState.pendingState === state)
  ) {
    return;
  }

  const persisted = await loadPersistedPkceState();
  if (!persisted) {
    return;
  }

  if (state && persisted.pendingState !== state) {
    return;
  }

  loginState.pendingState = persisted.pendingState;
  loginState.codeVerifier = persisted.codeVerifier;
  loginState.mode = persisted.mode;
  loginState.source = persisted.source;
}

function trackLoginStarted(mode: PaprAuthMode, source: PaprLoginSource): void {
  trackLoginEvent?.("paprwork_papr_login_started", { mode, source });
}

function trackLoginCompleted(mode: PaprAuthMode | undefined, source: PaprLoginSource | undefined): void {
  trackLoginEvent?.("paprwork_papr_login_completed", {
    ...(mode ? { mode } : {}),
    ...(source ? { source } : {}),
  });
}

function trackLoginFailed(
  error: string,
  options?: {
    mode?: PaprAuthMode;
    source?: PaprLoginSource;
    stage?: "start" | "callback";
  },
): void {
  trackLoginEvent?.("paprwork_papr_login_failed", {
    error,
    ...(options?.mode ? { mode: options.mode } : {}),
    ...(options?.source ? { source: options.source } : {}),
    ...(options?.stage ? { stage: options.stage } : {}),
  });
}

/** Build Auth0 authorize URL. Use screen_hint=signup so new users see registration, not login. */
export function buildAuth0AuthorizeUrl(params: {
  state: string;
  codeChallenge: string;
  mode?: PaprAuthMode;
}): URL {
  const authUrl = new URL(`https://${AUTH0_DOMAIN}/authorize`);
  authUrl.searchParams.set("client_id", AUTH0_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", AUTH0_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", params.codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("scope", AUTH0_SCOPE);
  authUrl.searchParams.set("state", params.state);
  authUrl.searchParams.set("audience", `https://${AUTH0_DOMAIN}/userinfo`);

  if (params.mode === "signup") {
    authUrl.searchParams.set("screen_hint", "signup");
  } else if (params.mode === "login") {
    authUrl.searchParams.set("screen_hint", "login");
  }

  return authUrl;
}

/** Map Auth0 callback errors to actionable messages for the app UI. */
export function formatAuth0CallbackError(
  error: string,
  errorDescription?: string | null,
): string {
  const code = error.toLowerCase();
  const desc = (errorDescription || "").toLowerCase();

  if (code === "access_denied") {
    if (
      desc.includes("wrong") ||
      desc.includes("invalid") ||
      desc.includes("password") ||
      desc.includes("credentials")
    ) {
      return (
        "Incorrect email or password. If you don't have a Papr account yet, " +
        "use Create Account instead of Sign in."
      );
    }
    if (desc.includes("signup") || desc.includes("sign up") || desc.includes("register")) {
      return "No Papr account found for that email. Use Create Account to register.";
    }
    return "Sign-in was cancelled. Please try again.";
  }

  if (
    desc.includes("user") &&
    (desc.includes("not found") ||
      desc.includes("doesn't exist") ||
      desc.includes("does not exist") ||
      desc.includes("no user"))
  ) {
    return "No Papr account found for that email. Use Create Account to register a new account.";
  }

  if (errorDescription) {
    return `Authentication failed: ${errorDescription}`;
  }

  return `Authentication failed (${error}). Please try again.`;
}

function notifyLoginError(win: BrowserWindow | undefined, message: string): void {
  trackLoginFailed(message, {
    mode: loginState.mode,
    source: loginState.source,
    stage: "callback",
  });
  if (!win) return;
  win.webContents.send("papr:login-error", { error: message });
}

// ─── PKCE Helpers ──────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return crypto.randomBytes(16).toString("hex");
}

// ─── Token Exchange ────────────────────────────────────────────

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<{
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  token_type: string;
}> {
  const response = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: AUTH0_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: AUTH0_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(
      `Token exchange failed: ${response.status} ${errorData.error_description || errorData.error || response.statusText}`,
    );
  }

  return response.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
    token_type: string;
  }>;
}

// ─── JWT Decode (no verification — tokens come from Auth0 over TLS) ───

function decodeIdToken(idToken: string): Record<string, any> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload);
}



// ─── Token Refresh ─────────────────────────────────────────────

/**
 * Use Auth0 refresh_token to get a new id_token, then extract a fresh
 * Parse sessionToken from the JWT claims.
 * Returns the new sessionToken (already persisted to keychain + profile).
 */
async function refreshSessionToken(
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage,
): Promise<string> {
  const refreshToken = await customKeysStorage.getKeyByName("PAPR_REFRESH_TOKEN");
  if (!refreshToken) {
    throw new Error("No refresh token available — user must re-login");
  }

  console.log("[PaprLogin] Refreshing session token via Auth0...");

  const response = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: AUTH0_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as Record<string, string>;
    // If refresh token is revoked/expired, clear it so we don't retry endlessly
    if (response.status === 403 || response.status === 401) {
      const meta = await customKeysStorage.getKeyMetadataByName("PAPR_REFRESH_TOKEN");
      if (meta) await customKeysStorage.deleteKey(meta.id);
      console.error("[PaprLogin] Refresh token revoked or expired, cleared.");
    }
    throw new Error(
      `Token refresh failed: ${response.status} ${errorData.error_description || errorData.error || response.statusText}`,
    );
  }

  const tokens = (await response.json()) as {
    access_token: string;
    id_token?: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!tokens.id_token) {
    throw new Error("No id_token in refresh response");
  }

  // Auth0 may rotate refresh tokens — store the new one if provided
  if (tokens.refresh_token) {
    await customKeysStorage.addKey({
      name: "PAPR_REFRESH_TOKEN",
      value: tokens.refresh_token,
    });
  }

  // Extract new Parse session token from the fresh JWT
  const claims = decodeIdToken(tokens.id_token);
  const newSessionToken = claims["https://papr.scope.com/sessionToken"];
  if (!newSessionToken) {
    throw new Error("Refreshed ID token missing Parse sessionToken claim");
  }

  // Persist the new session token
  await customKeysStorage.addKey({
    name: "PAPR_SESSION_TOKEN",
    value: newSessionToken,
  });

  const profile = settingsStorage.getPaprProfile();
  if (profile) {
    settingsStorage.setPaprProfile({
      ...profile,
      sessionToken: newSessionToken,
    });
  }

  console.log("[PaprLogin] Session token refreshed successfully.");
  return newSessionToken;
}

/**
 * Wrapper around parseGraphQL that auto-refreshes the session on 401/expired errors.
 * Retries the original call once with the new token.
 */
async function parseGraphQLWithRefresh(
  sessionToken: string,
  query: string,
  variables: Record<string, any>,
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage,
): Promise<any> {
  try {
    return await parseGraphQL(sessionToken, query, variables);
  } catch (error: any) {
    const msg = error?.message || "";
    // Detect session expiry — Parse returns "Invalid session token" or HTTP 209
    if (
      msg.includes("Invalid session") ||
      msg.includes("209") ||
      msg.includes("unauthorized") ||
      msg.includes("401")
    ) {
      console.log("[PaprLogin] Session token expired, attempting refresh...");
      const newToken = await refreshSessionToken(customKeysStorage, settingsStorage);
      return await parseGraphQL(newToken, query, variables);
    }
    throw error;
  }
}

// ─── Parse GraphQL Client ──────────────────────────────────────

async function parseGraphQL(
  sessionToken: string,
  query: string,
  variables: Record<string, any>,
): Promise<any> {
  const response = await fetch(PARSE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Session-Token": sessionToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Parse GraphQL error: ${response.status} ${text}`);
  }

  const result = (await response.json()) as { data?: any; errors?: any[] };
  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  return result.data;
}

// ─── GraphQL Mutations (matching papr-dev-platform) ────────────

const CREATE_ORGANIZATION = `
  mutation CreateOrganization(
    $name: String!,
    $ownerId: ID!,
    $workspaceId: ID,
    $planTier: String,
    $rateLimits: Object
  ) {
    createOrganization(
      input: {
        fields: {
          name: $name
          owner: { link: $ownerId }
          workspace: { link: $workspaceId }
          plan_tier: $planTier
          rate_limits: $rateLimits
        }
      }
    ) {
      organization {
        objectId
        name
      }
    }
  }
`;

const CREATE_NAMESPACE = `
  mutation CreateNamespace(
    $name: String!,
    $organizationId: ID!,
    $organizationIdString: String!,
    $environmentType: String!,
    $isActive: Boolean!
  ) {
    createNamespace(
      input: {
        fields: {
          name: $name
          environment_type: $environmentType
          organization: { link: $organizationId }
          organization_id: $organizationIdString
          is_active: $isActive
        }
      }
    ) {
      namespace {
        objectId
        name
      }
    }
  }
`;

const UPDATE_ORG_DEFAULT_NAMESPACE = `
  mutation UpdateOrganizationDefaultNamespace(
    $organizationId: ID!,
    $defaultNamespaceId: ID!
  ) {
    updateOrganization(
      input: {
        id: $organizationId
        fields: {
          default_namespace: { link: $defaultNamespaceId }
        }
      }
    ) {
      organization {
        objectId
      }
    }
  }
`;

const UPDATE_WORKSPACE_ORG = `
  mutation UpdateWorkspaceOrganization(
    $workspaceId: ID!,
    $organizationId: ID!
  ) {
    updateWorkSpace(
      input: {
        id: $workspaceId
        fields: {
          organization: { link: $organizationId }
        }
      }
    ) {
      workspace {
        objectId
      }
    }
  }
`;

const CREATE_API_KEY = `
  mutation CreateAPIKey(
    $key: String!,
    $name: String!,
    $organizationId: ID!,
    $namespaceId: ID!,
    $namespaceIdString: String!,
    $environment: String!,
    $permissions: [Any],
    $isActive: Boolean!,
    $userId: ID!,
    $workspaceId: String!
  ) {
    createAPIKey(
      input: {
        fields: {
          key: $key
          name: $name
          organization: { link: $organizationId }
          namespace: { link: $namespaceId }
          namespace_id: $namespaceIdString
          environment: $environment
          permissions: $permissions
          is_active: $isActive
          ACL: {
            users: {
              userId: $userId
              read: true
              write: true
            }
            roles: {
              roleName: $workspaceId
              read: true
              write: true
            }
            public: { read: false, write: false }
          }
        }
      }
    ) {
      aPIKey {
        objectId
        key
      }
    }
  }
`;

// Query to get API keys for a namespace
const GET_NAMESPACE_API_KEYS = `
  query GetNamespaceApiKeys($namespaceId: ID!) {
    aPIKeys(where: { namespace: { have: { objectId: { equalTo: $namespaceId } } }, is_active: { equalTo: true } }) {
      edges {
        node {
          objectId
          key
        }
      }
    }
  }
`;

// ─── API Key Generation ────────────────────────────────────────

// Query to get ALL organizations user has access to
// Gets organizations from:
// 1. Owned organizations (user is owner)
// 2. Workspace memberships (user is member via workspace_follower → workspace → organization)
const GET_USER_ORGANIZATIONS_VIA_WORKSPACES = `
  query GetUserOrganizationsViaWorkspaces($userId: ID!) {
    workspace_followers(where: { 
      user: { have: { objectId: { equalTo: $userId } } }
      archive: { equalTo: false }
      isMember: { equalTo: true }
    }) {
      edges {
        node {
          objectId
          workspace {
            objectId
            workspace_name
            organization {
              objectId
              name
              logoUrl
            }
          }
        }
      }
    }
  }
`;

// Query to get all namespaces for an organization
const GET_ORG_NAMESPACES = `
  query GetOrgNamespaces($orgId: ID!) {
    namespaces(where: { organization: { have: { objectId: { equalTo: $orgId } } } }, order: createdAt_DESC) {
      edges {
        node {
          objectId
          name
          environment_type
          is_active
        }
      }
    }
  }
`;

function generateApiKey(organizationId: string, namespaceId: string): string {
  const randomKey = crypto.randomBytes(32).toString("base64url").slice(0, 32);
  return `sk-org-${organizationId}-namespace-${namespaceId}-${randomKey}`;
}

function memberRoleName(workspaceId: string): string {
  return workspaceId.startsWith("member-") ? workspaceId : `member-${workspaceId}`;
}

function deriveOrgName(userEmail: string): string {
  return userEmail.includes("@")
    ? userEmail.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "-")
    : "default";
}

// Workspace-scoped org lookup (never scans all namespaces globally)
const GET_WORKSPACE_ORG = `
  query GetWorkspaceOrganization($workspaceId: ID!) {
    workSpace(id: $workspaceId) {
      objectId
      workspace_name
      organization {
        objectId
        name
        default_namespace {
          objectId
          name
        }
      }
    }
  }
`;

// Set namespace ACL: owner userId + role:member-{workspaceId}, no public access
const UPDATE_NAMESPACE_ACL = `
  mutation UpdateNamespaceACL(
    $namespaceId: ID!,
    $userId: ID!,
    $roleName: String!
  ) {
    updateNamespace(
      input: {
        id: $namespaceId
        fields: {
          ACL: {
            users: {
              userId: $userId
              read: true
              write: true
            }
            roles: {
              roleName: $roleName
              read: true
              write: true
            }
            public: { read: false, write: false }
          }
        }
      }
    ) {
      namespace {
        objectId
      }
    }
  }
`;

async function getSelectedWorkspaceId(
  sessionToken: string,
  userId: string,
): Promise<string | undefined> {
  const info = await getSelectedWorkspaceInfo(sessionToken, userId);
  return info.workspaceId;
}

async function updateNamespaceACL(
  sessionToken: string,
  namespaceId: string,
  userId: string,
  workspaceId: string,
): Promise<void> {
  const roleName = memberRoleName(workspaceId);
  try {
    await parseGraphQL(sessionToken, UPDATE_NAMESPACE_ACL, {
      namespaceId,
      userId,
      roleName,
    });
    console.log(
      `[PaprLogin] Namespace ACL set: userId=${userId}, ${roleName}, public=false`,
    );
  } catch (aclError) {
    console.error("[PaprLogin] Failed to set namespace ACL:", aclError);
    throw aclError;
  }
}

// ─── Provisioning (org + namespace + API key) ──────────────────

/**
 * Check if user has an existing org/namespace/API key.
 * If not, create them. Returns the API key string.
 */
interface ProvisionResult {
  apiKey: string;
  organizationId: string;
  namespaceId: string;
  namespaceName: string;
}

async function provisionOrGetApiKey(
  sessionToken: string,
  userId: string,
  userEmail: string,
  workspaceId?: string,
): Promise<ProvisionResult> {
  console.log("[PaprLogin] Provisioning org/namespace (workspace-scoped)...");

  const orgName = deriveOrgName(userEmail);

  if (!workspaceId) {
    workspaceId = await getSelectedWorkspaceId(sessionToken, userId);
    if (workspaceId) {
      console.log(`[PaprLogin] Selected workspace: ${workspaceId}`);
    } else {
      console.log("[PaprLogin] No selected workspace — will create one");
    }
  }

  // 1. Workspace-scoped: only use org/namespace linked to the user's selected workspace
  if (workspaceId) {
    try {
      const wsData = await parseGraphQL(sessionToken, GET_WORKSPACE_ORG, {
        workspaceId,
      });
      const wsOrg = wsData.workSpace?.organization as
        | {
            objectId: string;
            name: string;
            default_namespace?: { objectId: string; name?: string };
          }
        | undefined;

      if (wsOrg?.objectId) {
        console.log(
          `[PaprLogin] Workspace ${workspaceId} → org "${wsOrg.name}" (${wsOrg.objectId})`,
        );
        if (wsOrg.default_namespace?.objectId) {
          return await resolveOrgApiKey(
            sessionToken,
            userId,
            wsOrg.objectId,
            wsOrg.default_namespace.objectId,
            wsOrg.default_namespace.name || "default",
            workspaceId,
          );
        }

        console.log("[PaprLogin] Workspace org has no default namespace — creating one");
        return await createNamespaceAndKey(
          sessionToken,
          userId,
          wsOrg.objectId,
          orgName,
          workspaceId,
        );
      }

      console.log(
        `[PaprLogin] Workspace ${workspaceId} has no organization — creating new org`,
      );
    } catch (wsErr) {
      console.warn("[PaprLogin] Workspace org lookup failed:", wsErr);
    }
  }

  // 2. No org on workspace — full provisioning (new org + namespace + key)
  return await provisionNewOrgNamespace(sessionToken, userId, orgName, workspaceId);
}

async function provisionNewOrgNamespace(
  sessionToken: string,
  userId: string,
  orgName: string,
  workspaceId?: string,
): Promise<ProvisionResult> {
  console.log("[PaprLogin] Full provisioning: org + namespace + API key...");

  if (!workspaceId) {
    try {
      console.log("[PaprLogin] No workspace found, calling createWorkspace cloud function...");
      const wsResult = await parseGraphQL(sessionToken, `
        mutation CreateWorkspaceCloud($input: CloudCodeFunctionInput!) {
          callCloudCode(input: $input) {
            result
          }
        }
      `, {
        input: {
          functionName: "createWorkspace",
          params: {
            workspace_name: orgName,
            workspace_url: orgName,
            image: {
              __type: "File",
              name: "default-workspace.png",
              url: "https://parseserverstoragewest.blob.core.windows.net/parse/default-workspace.png",
            },
          },
        },
      });

      const cloudResult = wsResult.callCloudCode?.result;
      if (cloudResult?.workspace?.objectId) {
        workspaceId = cloudResult.workspace.objectId as string;
        console.log(`[PaprLogin] Created workspace via cloud function: ${workspaceId}`);
      }
    } catch (wsCreateErr) {
      console.warn("[PaprLogin] Cloud function createWorkspace failed:", wsCreateErr);
    }
  }

  const createOrgData = await parseGraphQL(sessionToken, CREATE_ORGANIZATION, {
    name: orgName,
    ownerId: userId,
    workspaceId: workspaceId || undefined,
    planTier: "developer",
    rateLimits: {
      max_memory_operations_per_month: 1000,
      max_storage_gb: 1,
      max_active_memories: 2500,
      rate_limit_per_minute: 10,
    },
  });

  const orgId = createOrgData.createOrganization.organization.objectId as string;
  console.log(`[PaprLogin] Created organization: ${orgId}`);

  if (workspaceId) {
    await parseGraphQL(sessionToken, UPDATE_WORKSPACE_ORG, {
      workspaceId,
      organizationId: orgId,
    });
  }

  return await createNamespaceAndKey(
    sessionToken,
    userId,
    orgId,
    orgName,
    workspaceId || "",
  );
}

/**
 * Create a namespace + API key under an existing org that has no namespace yet.
 */
async function createNamespaceAndKey(
  sessionToken: string,
  userId: string,
  orgId: string,
  orgName: string,
  workspaceId: string,
): Promise<ProvisionResult> {
  const nsName = `${orgName}-dev`;
  console.log(`[PaprLogin] Creating namespace "${nsName}" under org ${orgId}...`);

  const createNsData = await parseGraphQL(sessionToken, CREATE_NAMESPACE, {
    name: nsName,
    organizationId: orgId,
    organizationIdString: orgId,
    environmentType: "development",
    isActive: true,
  });

  const nsId = createNsData.createNamespace.namespace.objectId as string;
  console.log(`[PaprLogin] Created namespace: ${nsId}`);

  if (workspaceId) {
    await updateNamespaceACL(sessionToken, nsId, userId, workspaceId);
  } else {
    console.warn(
      "[PaprLogin] No workspaceId — namespace ACL not set (namespace may inherit public CLP)",
    );
  }

  await parseGraphQL(sessionToken, UPDATE_ORG_DEFAULT_NAMESPACE, {
    organizationId: orgId,
    defaultNamespaceId: nsId,
  });

  const key = await createApiKey(sessionToken, userId, orgId, nsId, workspaceId);
  return {
    apiKey: key,
    organizationId: orgId,
    namespaceId: nsId,
    namespaceName: nsName,
  };
}

/**
 * Given an org + namespace, reuse an existing namespace API key or create one.
 */
async function resolveOrgApiKey(
  sessionToken: string,
  userId: string,
  orgId: string,
  namespaceId: string,
  namespaceName: string,
  workspaceId: string,
): Promise<ProvisionResult> {
  const keyData = await parseGraphQL(sessionToken, GET_NAMESPACE_API_KEYS, {
    namespaceId,
  });
  const existingKey = keyData.aPIKeys?.edges?.[0]?.node;
  if (existingKey?.key) {
    console.log("[PaprLogin] Reusing existing API key for namespace");
    return { apiKey: existingKey.key, organizationId: orgId, namespaceId, namespaceName };
  }

  console.log("[PaprLogin] No API key for namespace, creating one...");
  const newKey = await createApiKey(sessionToken, userId, orgId, namespaceId, workspaceId);
  return { apiKey: newKey, organizationId: orgId, namespaceId, namespaceName };
}

async function createApiKey(
  sessionToken: string,
  userId: string,
  orgId: string,
  nsId: string,
  workspaceId: string,
): Promise<string> {
  const apiKeyValue = generateApiKey(orgId, nsId);
  const roleName = memberRoleName(workspaceId);

  const keyData = await parseGraphQL(sessionToken, CREATE_API_KEY, {
    key: apiKeyValue,
    name: `Development API Key - ${new Date().toISOString().split("T")[0]}`,
    organizationId: orgId,
    namespaceId: nsId,
    namespaceIdString: nsId,
    environment: "development",
    permissions: ["read", "write", "delete"],
    isActive: true,
    userId,
    workspaceId: roleName,
  });

  const createdKey = keyData.createAPIKey.aPIKey.key;
  console.log(`[PaprLogin] Created API key for namespace ${nsId}`);
  return createdKey;
}

// ─── Get workspace ID from user's profile ──────────────────────

const GET_USER_WORKSPACE = `
  query GetUserWorkspace($userId: ID!) {
    user(id: $userId) {
      isSelectedWorkspaceFollower {
        workspace {
          objectId
          workspace_name
          organization {
            objectId
            name
          }
        }
      }
    }
  }
`;

interface SelectedWorkspaceInfo {
  workspaceId?: string;
  workspaceName?: string;
  organizationId?: string;
  organizationName?: string;
}

async function getSelectedWorkspaceInfo(
  sessionToken: string,
  userId: string,
): Promise<SelectedWorkspaceInfo> {
  const userData = await parseGraphQL(sessionToken, GET_USER_WORKSPACE, { userId });
  const workspace = userData.user?.isSelectedWorkspaceFollower?.workspace as
    | {
        objectId?: string;
        workspace_name?: string;
        organization?: { objectId?: string; name?: string };
      }
    | undefined;

  return {
    workspaceId: workspace?.objectId,
    workspaceName: workspace?.workspace_name,
    organizationId: workspace?.organization?.objectId,
    organizationName: workspace?.organization?.name,
  };
}

// ─── IPC Handlers ──────────────────────────────────────────────

async function completePaprAuthCallback(
  code: string | null,
  state: string | null,
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage,
): Promise<{
  success: true;
  email: string;
  name: string;
  userId: string;
}> {
  await hydratePkceForCallback(state);

  const completedMode = loginState.mode;
  const completedSource = loginState.source;

  if (!code) throw new Error("No authorization code received");
  if (!state || state !== loginState.pendingState) {
    throw new Error("Invalid state parameter — possible CSRF attack");
  }
  if (!loginState.codeVerifier) {
    throw new Error("No code verifier found — login flow may have expired. Please try again.");
  }

  console.log("[PaprLogin] Exchanging authorization code for tokens...");
  const tokens = await exchangeCodeForTokens(code, loginState.codeVerifier);

  clearInMemoryPkceState();
  await clearPersistedPkceState();

  if (!tokens.id_token) {
    throw new Error("No ID token received from Auth0");
  }

  const claims = decodeIdToken(tokens.id_token);
  const parseSessionToken = claims["https://papr.scope.com/sessionToken"];
  const objectId = claims["https://papr.scope.com/objectId"];
  const displayName =
    claims["https://papr.scope.com/displayName"] || claims.nickname || claims.name;
  const email = claims.email;
  const profileImage =
    typeof claims.picture === "string" ? claims.picture : undefined;

  if (!parseSessionToken || !objectId) {
    throw new Error(
      "Your account setup didn't finish. If you just signed up, wait a moment and try Sign in again.",
    );
  }

  console.log(`[PaprLogin] Authenticated user: ${email} (${objectId})`);

  let workspaceInfo: SelectedWorkspaceInfo = {};
  try {
    workspaceInfo = await getSelectedWorkspaceInfo(parseSessionToken, objectId);
  } catch (e) {
    console.warn("[PaprLogin] Could not fetch workspace info:", e);
  }

  const provision = await provisionOrGetApiKey(
    parseSessionToken,
    objectId,
    email || "user",
    workspaceInfo.workspaceId,
  );

  await customKeysStorage.addKey({
    name: "PAPR_API_KEY",
    value: provision.apiKey,
  });
  invalidateKeyCache("PAPR_API_KEY");

  await customKeysStorage.addKey({
    name: "PAPR_SESSION_TOKEN",
    value: parseSessionToken,
  });

  if (tokens.refresh_token) {
    await customKeysStorage.addKey({
      name: "PAPR_REFRESH_TOKEN",
      value: tokens.refresh_token,
    });
  }

  settingsStorage.setPaprProfile({
    userId: objectId,
    email: email || "",
    displayName: displayName || "",
    authenticatedAt: new Date().toISOString(),
    sessionToken: parseSessionToken,
    organizationId: provision.organizationId,
    activeNamespaceId: provision.namespaceId,
    activeNamespaceName: provision.namespaceName,
    workspaceId: workspaceInfo.workspaceId,
    workspaceName: workspaceInfo.workspaceName,
  });

  await syncProfileToGatewaySettings(
    email || "",
    objectId,
    displayName || "",
    profileImage,
    provision.namespaceName,
  );
  console.log("[PaprLogin] Login complete. API key stored as PAPR_API_KEY.");
  trackLoginCompleted(completedMode, completedSource);

  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.webContents.send("papr:login-success", {
      email: email || "",
      name: displayName || "",
      userId: objectId,
    });
  }

  return {
    success: true,
    email: email || "",
    name: displayName || "",
    userId: objectId,
  };
}

export function initializePaprLoginIPC(
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage,
  options?: {
    trackLoginEvent?: LoginTelemetryTracker;
  },
) {
  trackLoginEvent = options?.trackLoginEvent;
  void restorePkceFromDisk();
  // Check if user is already logged in
  ipcMain.handle("papr:check-login-status", async () => {
    try {
      const keys = await customKeysStorage.listKeys();
      const hasApiKey = keys.some((k) => k.name === "PAPR_API_KEY");
      const profile = settingsStorage.getPaprProfile();

      return {
        success: true,
        isLoggedIn: hasApiKey,
        email: profile?.email || null,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Return stored Papr profile for Settings UI and telemetry (no session token)
  ipcMain.handle("papr:get-profile", async () => {
    try {
      const profile = settingsStorage.getPaprProfile();
      if (!profile) {
        return { success: true, profile: undefined };
      }

      const { sessionToken: _sessionToken, ...safeProfile } = profile;
      return {
        success: true,
        profile: {
          ...safeProfile,
          workspaceId: profile.workspaceId,
          workspaceName: profile.workspaceName,
          organizationId: profile.organizationId,
          activeNamespaceId: profile.activeNamespaceId,
          activeNamespaceName: profile.activeNamespaceName,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Start PKCE login flow (mode: signup shows Auth0 registration, login shows sign-in)
  ipcMain.handle(
    "papr:start-login",
    async (_event, mode?: PaprAuthMode, source?: PaprLoginSource) => {
    try {
      const authMode: PaprAuthMode = mode === "signup" ? "signup" : "login";
      const loginSource: PaprLoginSource =
        source === "auth_wall" || source === "settings" ? source : "unknown";
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateState();

      loginState.pendingState = state;
      loginState.codeVerifier = codeVerifier;
      loginState.mode = authMode;
      loginState.source = loginSource;

      await persistPkceState({
        pendingState: state,
        codeVerifier,
        mode: authMode,
        source: loginSource,
        createdAt: new Date().toISOString(),
      });

      const authUrl = buildAuth0AuthorizeUrl({
        state,
        codeChallenge,
        mode: authMode,
      });

      console.log(`[PaprLogin] Starting Auth0 flow (mode=${authMode})`);
      trackLoginStarted(authMode, loginSource);
      await shell.openExternal(authUrl.toString());

      return { success: true };
    } catch (error) {
      clearInMemoryPkceState();
      await clearPersistedPkceState();
      const message = error instanceof Error ? error.message : "Failed to start login";
      trackLoginFailed(message, {
        mode: mode === "signup" ? "signup" : "login",
        source:
          source === "auth_wall" || source === "settings" ? source : "unknown",
        stage: "start",
      });
      return {
        success: false,
        error: message,
      };
    }
  },
  );

  // Handle the deep link callback
  ipcMain.handle("papr:handle-callback", async (_event, callbackUrl: string) => {
    try {
      const url = new URL(callbackUrl);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        throw new Error(
          formatAuth0CallbackError(error, url.searchParams.get("error_description")),
        );
      }

      return await completePaprAuthCallback(
        code,
        state,
        customKeysStorage,
        settingsStorage,
      );
    } catch (error) {
      console.error("[PaprLogin] Login failed:", error);

      const message = error instanceof Error ? error.message : "Login failed";
      notifyLoginError(BrowserWindow.getAllWindows()[0], message);
      clearInMemoryPkceState();
      await clearPersistedPkceState();

      return {
        success: false,
        error: message,
      };
    }
  });

  // Logout — clear stored keys + OAuth tokens, open Auth0 logout
  ipcMain.handle("papr:logout", async () => {
    try {
      const keys = await customKeysStorage.listKeys();

      for (const key of keys) {
        if (key.name === "PAPR_API_KEY" || key.name === "PAPR_ACCESS_TOKEN" || key.name === "PAPR_REFRESH_TOKEN" || key.name === "PAPR_SESSION_TOKEN") {
          await customKeysStorage.deleteKey(key.id);
        }
      }

      // Invalidate Gateway's cached PAPR_API_KEY so it stops using the old key
      invalidateKeyCache("PAPR_API_KEY");

      // Clear PKCE state
      clearInMemoryPkceState();
      await clearPersistedPkceState();

      settingsStorage.clearPaprProfile();
      await clearPaprUserIdFromGatewaySettings();
      try {
        const { clearMemoryPreviewCache } = await import(
          "../../gateway/services/MemoryPreviewCache.js"
        );
        await clearMemoryPreviewCache();
      } catch {
        // Non-fatal
      }
      console.log("[PaprLogin] Logged out, all tokens cleared.");

      // Notify renderer about logout success
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send("papr:logout-success");
      }

      // Open Auth0 logout URL to clear browser session (so next login shows account picker)
      const logoutUrl = `https://${AUTH0_DOMAIN}/v2/logout?client_id=${AUTH0_CLIENT_ID}&returnTo=${encodeURIComponent("https://papr.ai")}`;
      shell.openExternal(logoutUrl);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Logout failed",
      };
    }
  });

  // List all namespaces for the user's organization
  ipcMain.handle("papr:list-namespaces", async () => {
    try {
      const profile = settingsStorage.getPaprProfile();
      if (!profile?.sessionToken || !profile?.organizationId) {
        return { success: false, error: "Not logged in or missing org info" };
      }

      const data = await parseGraphQLWithRefresh(profile.sessionToken, GET_ORG_NAMESPACES, {
        orgId: profile.organizationId,
      }, customKeysStorage, settingsStorage);

      const namespaces = (data.namespaces?.edges || []).map((edge: any) => ({
        id: edge.node.objectId,
        name: edge.node.name,
        environmentType: edge.node.environment_type,
        isActive: edge.node.is_active,
      }));

      return {
        success: true,
        namespaces,
        activeNamespaceId: profile.activeNamespaceId,
      };
    } catch (error) {
      console.error("[PaprLogin] Failed to list namespaces:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list namespaces",
      };
    }
  });

  // List all organizations user has access to (via workspace membership)
  ipcMain.handle("papr:list-organizations", async () => {
    try {
      const profile = settingsStorage.getPaprProfile();
      if (!profile?.sessionToken || !profile?.userId) {
        return { success: false, error: "Not logged in" };
      }

      const data = await parseGraphQLWithRefresh(
        profile.sessionToken, 
        GET_USER_ORGANIZATIONS_VIA_WORKSPACES, 
        { userId: profile.userId },
        customKeysStorage, 
        settingsStorage
      );

      // Extract unique organizations from workspace_followers
      const orgMap = new Map<string, { id: string; name: string; role: string }>();

      (data.workspace_followers?.edges || []).forEach((edge: any) => {
        const org = edge.node?.workspace?.organization;
        if (org?.objectId && org?.name) {
          if (!orgMap.has(org.objectId)) {
            orgMap.set(org.objectId, {
              id: org.objectId,
              name: org.name,
              role: "member",
            });
          }
        }
      });

      // Discover orgs only via workspace membership (no global namespace scan)
      const organizations = Array.from(orgMap.values());
      console.log(`[PaprLogin] Found ${organizations.length} organizations via workspace membership`);

      return {
        success: true,
        organizations,
        activeOrganizationId: profile.organizationId,
      };
    } catch (error) {
      console.error("[PaprLogin] Failed to list organizations:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list organizations",
      };
    }
  });

  // Switch to a different organization
  ipcMain.handle("papr:switch-organization", async (_event, organizationId: string, organizationName: string) => {
    try {
      const profile = settingsStorage.getPaprProfile();
      if (!profile?.sessionToken) {
        return { success: false, error: "Not logged in" };
      }

      // Update profile with new active organization (clears namespace)
      settingsStorage.setPaprProfile({
        ...profile,
        organizationId,
        activeNamespaceId: undefined,
        activeNamespaceName: undefined,
      });

      console.log(`[PaprLogin] Switched to organization: ${organizationName} (${organizationId})`);

      // Notify renderer to reload namespaces
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send("papr:organization-changed", {
          organizationId,
          organizationName,
        });
      }

      return {
        success: true,
        organizationId,
        organizationName,
      };
    } catch (error) {
      console.error("[PaprLogin] Failed to switch organization:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to switch organization",
      };
    }
  });

  // Switch to a different namespace — gets or creates API key for it
  ipcMain.handle("papr:switch-namespace", async (_event, namespaceId: string, namespaceName: string) => {
    try {
      const profile = settingsStorage.getPaprProfile();
      if (!profile?.sessionToken || !profile?.organizationId || !profile?.userId) {
        return { success: false, error: "Not logged in or missing org info" };
      }

      const workspaceId =
        (await getSelectedWorkspaceId(profile.sessionToken, profile.userId)) || "";

      const resolved = await resolveOrgApiKey(
        profile.sessionToken,
        profile.userId,
        profile.organizationId,
        namespaceId,
        namespaceName,
        workspaceId,
      );
      const apiKey = resolved.apiKey;

      // Update stored PAPR_API_KEY
      await customKeysStorage.addKey({
        name: "PAPR_API_KEY",
        value: apiKey,
      });

      // Invalidate Gateway's cached PAPR_API_KEY so it picks up the new namespace's key
      invalidateKeyCache("PAPR_API_KEY");

      // Update profile with new active namespace
      settingsStorage.setPaprProfile({
        ...profile,
        activeNamespaceId: namespaceId,
        activeNamespaceName: namespaceName,
      });

      console.log(`[PaprLogin] Switched to namespace: ${namespaceName} (${namespaceId})`);

      // Notify renderer
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send("papr:namespace-changed", {
          namespaceId,
          namespaceName,
        });
      }

      return {
        success: true,
        namespaceId,
        namespaceName,
        apiKey,
      };
    } catch (error) {
      console.error("[PaprLogin] Failed to switch namespace:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to switch namespace",
      };
    }
  });

  ipcMain.handle("papr:list-workspace-members", async () => {
    try {
      const profile = settingsStorage.getPaprProfile();
      if (!profile?.sessionToken) {
        return { success: false, error: "Not logged in" };
      }

      let workspaceId = profile.workspaceId;
      let workspaceName = profile.workspaceName;
      if (!workspaceId && profile.userId) {
        const workspaceInfo = await getSelectedWorkspaceInfo(
          profile.sessionToken,
          profile.userId,
        );
        workspaceId = workspaceInfo.workspaceId;
        workspaceName = workspaceInfo.workspaceName;
        if (workspaceId) {
          settingsStorage.setPaprProfile({
            ...profile,
            workspaceId,
            workspaceName,
          });
        }
      }

      if (!workspaceId) {
        return { success: false, error: "No workspace found for your Papr account" };
      }

      const members = await fetchWorkspaceMembers(profile.sessionToken, workspaceId);
      return {
        success: true,
        workspaceId,
        workspaceName: workspaceName || "Workspace",
        members,
      };
    } catch (error) {
      console.error("[PaprLogin] Failed to list workspace members:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load team members",
      };
    }
  });

  ipcMain.handle("papr:invite-workspace-member", async (_event, email: string) => {
    try {
      const profile = settingsStorage.getPaprProfile();
      if (!profile?.sessionToken || !profile.userId) {
        return { success: false, error: "Not logged in" };
      }

      const workspaceInfo = await getSelectedWorkspaceInfo(
        profile.sessionToken,
        profile.userId,
      );

      if (!workspaceInfo.workspaceId) {
        return { success: false, error: "No workspace found for your Papr account" };
      }

      if (
        workspaceInfo.workspaceId !== profile.workspaceId ||
        workspaceInfo.workspaceName !== profile.workspaceName
      ) {
        settingsStorage.setPaprProfile({
          ...profile,
          workspaceId: workspaceInfo.workspaceId,
          workspaceName: workspaceInfo.workspaceName,
        });
      }

      const members = await fetchWorkspaceMembers(
        profile.sessionToken,
        workspaceInfo.workspaceId,
      );
      const existingEmails = new Set(
        members.map((member) => member.user.email.toLowerCase()),
      );

      const result = await sendWorkspaceInvite(
        {
          sessionToken: profile.sessionToken,
          workspaceId: workspaceInfo.workspaceId,
          organizationId:
            workspaceInfo.organizationId || profile.organizationId || workspaceInfo.workspaceId,
          organizationName:
            workspaceInfo.organizationName ||
            workspaceInfo.workspaceName ||
            "Papr",
          workspaceName: workspaceInfo.workspaceName || "Workspace",
          inviterId: profile.userId,
          inviterName: profile.displayName || profile.email,
          inviterImageUrl: profile.profileImage,
          email,
        },
        existingEmails,
      );

      if (result.alreadyMember) {
        return {
          success: false,
          error: `${result.email} is already on your team`,
        };
      }

      return {
        success: true,
        email: result.email,
        inviteLink: result.inviteLink,
      };
    } catch (error) {
      console.error("[PaprLogin] Failed to invite workspace member:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to send invite",
      };
    }
  });

  ipcMain.handle("papr:open-workspace-team", async () => {
    const platformUrl = process.env.PAPR_PLATFORM_URL || "https://dashboard.papr.ai";
    await shell.openExternal(`${platformUrl.replace(/\/$/, "")}/people`);
    return { success: true };
  });
}

/**
 * Handle a papr:// deep link URL directly from the main process.
 * Called from index.cjs when the app receives a deep link.
 */
export async function handlePaprAuthCallback(
  callbackUrl: string,
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage,
): Promise<void> {
  if (!callbackUrl.startsWith("papr://auth/callback")) return;

  try {
    const url = new URL(callbackUrl);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      throw new Error(
        formatAuth0CallbackError(error, url.searchParams.get("error_description")),
      );
    }

    await completePaprAuthCallback(code, state, customKeysStorage, settingsStorage);
  } catch (err) {
    console.error("[PaprLogin] Callback failed:", err);

    const message = err instanceof Error ? err.message : "Login failed";
    notifyLoginError(BrowserWindow.getAllWindows()[0], message);
    clearInMemoryPkceState();
    await clearPersistedPkceState();
  }
}

/**
 * Cleanup function called on app shutdown.
 */
export function cleanupPaprLogin(): void {
  clearInMemoryPkceState();
  trackLoginEvent = undefined;
  console.log("[PaprLogin] Cleaned up login state.");
}
