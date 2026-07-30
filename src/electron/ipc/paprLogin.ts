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
  notifyGatewayWorkspaceSwitch,
  notifyGatewayPaprApiKeyUpdate,
  registerPaprWorkspaceHandlers,
} from "./paprWorkspace.js";
import { registerPaprLegacyMigrationHandlers } from "./paprLegacyMigration.js";
import {
  cacheNamespacesForOrg,
  getCachedNamespaces,
  readPaprWorkspaceCache,
  writePaprWorkspaceCache,
  type CachedWorkspace,
} from "./paprWorkspaceCache.js";
import {
  fetchWorkspaceMembers,
  sendWorkspaceInvite,
} from "./paprWorkspaceTeam.js";
import { registerPaprBillingHandlers } from "./paprBilling.js";
import * as crypto from "crypto";
import path from "node:path";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";
import {
  getPaprBaseDir,
  readActiveWorkspacePointer,
} from "../../core/utils/paprWorkspace.js";
import {
  paprApiKeyMatchesNamespace,
  paprNamespaceApiKeyName,
} from "../../core/utils/paprApiKey.js";

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
  workspaceId?: string,
  workspaceName?: string,
): Promise<void> {
  try {
    const fsP = await import("fs/promises");
    const pathM = await import("path");
    const { invalidatePaprUserIdCache } = await import(
      "../../gateway/utils/paprUserId.js"
    );
    const { invalidateGatewayPaprProfileCache } = await import(
      "../../gateway/utils/paprGatewayProfile.js"
    );
    const settingsPath = path.join(getPaprDataDir(), "settings.json");
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
    if (workspaceId?.trim()) {
      profile.paprWorkspaceId = workspaceId.trim();
    }
    if (workspaceName?.trim()) {
      profile.paprWorkspaceName = workspaceName.trim();
    }
    await fsP.mkdir(pathM.dirname(settingsPath), { recursive: true });
    await fsP.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    invalidatePaprUserIdCache();
    invalidateGatewayPaprProfileCache();
    console.log(`[PaprLogin] Synced profile to gateway settings: ${email} (${userId})`);
  } catch (e) {
    console.warn("[PaprLogin] Failed to sync profile to gateway settings:", e);
  }
}

/** Remove Papr user id from gateway settings after logout. */
export async function clearPaprUserIdFromGatewaySettings(): Promise<void> {
  try {
    const fsP = await import("fs/promises");
    const { invalidatePaprUserIdCache } = await import(
      "../../gateway/utils/paprUserId.js"
    );
    const { invalidateGatewayPaprProfileCache } = await import(
      "../../gateway/utils/paprGatewayProfile.js"
    );
    const settingsPath = path.join(getPaprDataDir(), "settings.json");
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
    delete profile.paprWorkspaceId;
    delete profile.paprWorkspaceName;
    await fsP.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    invalidatePaprUserIdCache();
    invalidateGatewayPaprProfileCache();
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
  return path.join(getPaprBaseDir(), "data", "papr-auth-pkce.json");
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
  variables: Record<string, unknown>,
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage,
): Promise<ParseGraphQLJson> {
  try {
    return await parseGraphQL(sessionToken, query, variables);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "";
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

/** Loose JSON shape returned by Parse GraphQL (nested fields accessed throughout this module). */
type ParseGraphQLJson = {
  [key: string]: ParseGraphQLJson | ParseGraphQLJson[] | string | number | boolean | null | undefined;
};

function isTransientParseError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && "cause" in error ? String(error.cause) : "";
  const combined = `${msg} ${cause}`;
  return (
    combined.includes("Invalid server state") ||
    combined.includes("ECONNRESET") ||
    combined.includes("fetch failed") ||
    combined.includes("ETIMEDOUT") ||
    combined.includes("503") ||
    combined.includes("502") ||
    /Parse GraphQL error: 5\d\d/.test(combined)
  );
}

// ─── Parse GraphQL Client ──────────────────────────────────────

async function parseGraphQL(
  sessionToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<ParseGraphQLJson> {
  let lastError: unknown;
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
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

      const result = (await response.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
      if (result.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
      }

      return (result.data ?? {}) as ParseGraphQLJson;
    } catch (error) {
      lastError = error;
      if (!isTransientParseError(error) || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = 300 * 2 ** (attempt - 1);
      console.warn(
        `[PaprLogin] Transient Parse error (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
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

// Query to list workspaces the user belongs to (matches papr-dev-platform dashboard).
const GET_USER_WORKSPACES = `
  query GetUserWorkspaces($input: Workspace_followerWhereInput!) {
    workspace_followers(where: $input) {
      edges {
        node {
          objectId
          archive
          isMember
          isSelected
          workspace {
            objectId
            workspace_name
            organization {
              objectId
              name
              logoUrl
              default_namespace {
                objectId
                name
              }
            }
          }
        }
      }
    }
  }
`;

/** Organizations the user owns directly (Parse class Organization → organizations). */
const GET_USER_OWNED_ORGANIZATIONS = `
  query GetUserOwnedOrganizations($userId: ID!) {
    organizations(
      where: {
        owner: { have: { objectId: { equalTo: $userId } } }
      }
      order: createdAt_DESC
    ) {
      edges {
        node {
          objectId
          name
          logoUrl
          default_namespace {
            objectId
            name
          }
          workspace {
            objectId
            workspace_name
          }
        }
      }
    }
  }
`;

// Query to get organization default namespace
const GET_ORG_DEFAULT_NAMESPACE = `
  query GetOrgDefaultNamespace($orgId: ID!) {
    organization(id: $orgId) {
      objectId
      name
      default_namespace {
        objectId
        name
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

const UPDATE_WORKSPACE_FOLLOWER_SELECTION = `
  mutation UpdateWorkspaceFollowerSelection($input: UpdateWorkspace_followerInput!) {
    updateWorkspace_follower(input: $input) {
      workspace_follower {
        id
        isSelected
      }
    }
  }
`;

const UPDATE_USER_SELECTED_WORKSPACE = `
  mutation UpdateUserSelectedWorkspace($input: UpdateUserInput!) {
    updateUser(input: $input) {
      user {
        objectId
        isSelectedWorkspaceFollower {
          objectId
        }
      }
    }
  }
`;

function workspaceDisplayName(input: {
  organizationName?: string;
  workspaceName?: string;
}): string {
  // Dashboard shows workspace_name (Papr, a12, Myadvice); org.name is often auto-provisioned.
  return input.workspaceName?.trim() || input.organizationName?.trim() || "Workspace";
}

type GraphQLExecutor = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<ParseGraphQLJson>;

interface UserWorkspaceOption {
  followerId: string;
  workspaceId: string;
  workspaceName: string;
  organizationId: string;
  organizationName: string;
  isSelected: boolean;
  role: string;
  defaultNamespaceId?: string;
}

interface OwnedOrgInfo {
  organizationId: string;
  organizationName: string;
  defaultNamespaceId?: string;
}

interface NamespaceOrgContext {
  developerOrgId?: string;
  ownedOrgById: Map<string, OwnedOrgInfo>;
  ownedOrgByWorkspaceId: Map<string, OwnedOrgInfo>;
}

/**
 * Which Parse org holds namespaces for a workspace.
 * Team workspaces: workspace.organization (matches dashboard).
 * Personal Papr workspace (thin owned-org shell): user.organization_id (developer org).
 */
export function resolveNamespaceOrganizationId(input: {
  followerOrgId: string;
  ownedOrg?: OwnedOrgInfo;
  developerOrgId?: string;
}): string {
  const { followerOrgId, ownedOrg, developerOrgId } = input;

  if (ownedOrg) {
    if (followerOrgId === ownedOrg.organizationId) {
      return ownedOrg.organizationId;
    }
    if (developerOrgId) {
      return developerOrgId;
    }
    return ownedOrg.organizationId;
  }

  return followerOrgId;
}

/** Prefer resolved namespace org on login; never raw follower org when developer org applies. */
export function resolveLoginOrganizationId(input: {
  namespaceOrganizationId?: string;
  provisionOrganizationId?: string;
  developerOrganizationId?: string;
}): string | undefined {
  return (
    input.namespaceOrganizationId?.trim() ||
    input.provisionOrganizationId?.trim() ||
    input.developerOrganizationId?.trim() ||
    undefined
  );
}

async function loadNamespaceOrgContext(
  userId: string,
  graphql: GraphQLExecutor,
): Promise<NamespaceOrgContext> {
  const ownedOrgById = new Map<string, OwnedOrgInfo>();
  const ownedOrgByWorkspaceId = new Map<string, OwnedOrgInfo>();
  let developerOrgId: string | undefined;

  try {
    const devData = (await graphql(GET_USER_DEVELOPER_ORG, { userId })) as {
      user?: { organization_id?: string };
    };
    developerOrgId = devData.user?.organization_id?.trim() || undefined;
  } catch (devError) {
    console.warn("[PaprLogin] Developer org lookup failed:", devError);
  }

  try {
    const ownedData = (await graphql(GET_USER_OWNED_ORGANIZATIONS, { userId })) as {
      organizations?: {
        edges?: Array<{
          node?: {
            objectId?: string;
            name?: string;
            default_namespace?: { objectId?: string };
            workspace?: { objectId?: string };
          };
        }>;
      };
    };
    for (const edge of ownedData.organizations?.edges ?? []) {
      const node = edge.node;
      const orgId = node?.objectId as string | undefined;
      const orgName = node?.name?.trim();
      const workspaceId = node?.workspace?.objectId;
      if (orgId && orgName) {
        const info: OwnedOrgInfo = {
          organizationId: orgId,
          organizationName: orgName,
          defaultNamespaceId: node?.default_namespace?.objectId,
        };
        ownedOrgById.set(orgId, info);
        if (workspaceId) {
          ownedOrgByWorkspaceId.set(workspaceId, info);
        }
      }
    }
  } catch (ownedError) {
    console.warn("[PaprLogin] Owned organizations lookup failed:", ownedError);
  }

  return { developerOrgId, ownedOrgById, ownedOrgByWorkspaceId };
}

async function resolveNamespaceOrganizationForWorkspace(
  sessionToken: string,
  userId: string,
  workspaceId: string,
): Promise<{
  organizationId: string;
  organizationName: string;
  defaultNamespaceId?: string;
} | null> {
  const graphql: GraphQLExecutor = (query, variables) =>
    parseGraphQL(sessionToken, query, variables);
  const context = await loadNamespaceOrgContext(userId, graphql);

  const wsData = (await parseGraphQL(sessionToken, GET_WORKSPACE_ORG, {
    workspaceId,
  })) as {
    workSpace?: {
      workspace_name?: string;
      organization?: {
        objectId: string;
        name: string;
        default_namespace?: { objectId: string; name?: string };
      };
    };
  };
  const wsOrg = wsData.workSpace?.organization;
  if (!wsOrg?.objectId) {
    return null;
  }

  const followerOrgId = wsOrg.objectId;
  const ownedOrg = context.ownedOrgByWorkspaceId.get(workspaceId);
  const namespaceOrgId = resolveNamespaceOrganizationId({
    followerOrgId,
    ownedOrg,
    developerOrgId: context.developerOrgId,
  });
  const namespaceOrgInfo =
    context.ownedOrgById.get(namespaceOrgId) ??
    (ownedOrg?.organizationId === namespaceOrgId ? ownedOrg : undefined);

  if (ownedOrg && namespaceOrgId !== followerOrgId) {
    console.log(
      `[PaprLogin] Workspace ${wsData.workSpace?.workspace_name ?? workspaceId}: ` +
        `using developer org ${namespaceOrgId} for namespaces ` +
        `(follower org ${followerOrgId}, owned org ${ownedOrg.organizationId})`,
    );
  }

  return {
    organizationId: namespaceOrgId,
    organizationName: namespaceOrgInfo?.organizationName ?? wsOrg.name,
    defaultNamespaceId:
      namespaceOrgInfo?.defaultNamespaceId ?? wsOrg.default_namespace?.objectId,
  };
}

async function fetchUserWorkspaces(
  userId: string,
  graphql: GraphQLExecutor,
): Promise<UserWorkspaceOption[]> {
  const ownedOrgIds = new Set<string>();
  const context = await loadNamespaceOrgContext(userId, graphql);
  for (const orgId of context.ownedOrgById.keys()) {
    ownedOrgIds.add(orgId);
  }

  const data = (await graphql(GET_USER_WORKSPACES, {
    input: {
      user: { have: { objectId: { equalTo: userId } } },
      isMember: { equalTo: true },
    },
  })) as {
    workspace_followers?: {
      edges?: Array<{
        node?: {
          objectId?: string;
          isSelected?: boolean;
          workspace?: {
            objectId?: string;
            workspace_name?: string;
            organization?: {
              objectId?: string;
              name?: string;
              default_namespace?: { objectId?: string; name?: string };
            };
          };
        };
      }>;
    };
  };

  const workspaces: UserWorkspaceOption[] = [];
  for (const edge of data.workspace_followers?.edges ?? []) {
    const node = edge.node;

    const workspace = node?.workspace;
    const organization = workspace?.organization;
    if (!node?.objectId || !workspace?.objectId || !organization?.objectId || !organization.name) {
      continue;
    }

    const followerOrgId = organization.objectId;
    const ownedOrg = context.ownedOrgByWorkspaceId.get(workspace.objectId);
    const namespaceOrgId = resolveNamespaceOrganizationId({
      followerOrgId,
      ownedOrg,
      developerOrgId: context.developerOrgId,
    });
    const namespaceOrgInfo =
      context.ownedOrgById.get(namespaceOrgId) ??
      (ownedOrg?.organizationId === namespaceOrgId ? ownedOrg : undefined);
    const namespaceOrgName = namespaceOrgInfo?.organizationName ?? organization.name;
    const defaultNamespaceId =
      namespaceOrgInfo?.defaultNamespaceId ?? organization.default_namespace?.objectId;

    if (ownedOrg && namespaceOrgId !== followerOrgId) {
      console.log(
        `[PaprLogin] Workspace ${workspace.workspace_name ?? workspace.objectId}: ` +
          `using developer org ${namespaceOrgId} for namespaces ` +
          `(follower org ${followerOrgId}, owned org ${ownedOrg.organizationId})`,
      );
    }

    workspaces.push({
      followerId: node.objectId,
      workspaceId: workspace.objectId,
      workspaceName: workspace.workspace_name?.trim() || organization.name,
      organizationId: namespaceOrgId,
      organizationName: namespaceOrgName,
      isSelected: node.isSelected === true,
      role: ownedOrgIds.has(namespaceOrgId) ? "owner" : "member",
      defaultNamespaceId,
    });
  }

  workspaces.sort((a, b) =>
    workspaceDisplayName(a).localeCompare(workspaceDisplayName(b)),
  );

  return workspaces;
}

/** Keep profile.organizationId aligned with the active workspace's namespace org. */
async function syncActiveWorkspaceOrganization(
  profile: PaprProfile,
  workspaces: UserWorkspaceOption[],
  settingsStorage: SettingsStorage,
  customKeysStorage: CustomKeysStorage,
): Promise<UserWorkspaceOption | undefined> {
  const activeWorkspaceId =
    profile.workspaceId ||
    workspaces.find((workspace) => workspace.isSelected)?.workspaceId ||
    workspaces[0]?.workspaceId;
  if (!activeWorkspaceId) {
    return undefined;
  }

  const active = workspaces.find((workspace) => workspace.workspaceId === activeWorkspaceId);
  const namespaceOrgId = active?.organizationId;
  if (!active || !namespaceOrgId) {
    return undefined;
  }

  const orgChanged = namespaceOrgId !== profile.organizationId;
  const workspaceMetadataChanged =
    active.workspaceId !== profile.workspaceId ||
    active.workspaceName !== profile.workspaceName;

  if (!orgChanged && !workspaceMetadataChanged) {
    return active;
  }

  settingsStorage.setPaprProfile({
    ...profile,
    workspaceId: active.workspaceId,
    workspaceName: active.workspaceName,
    organizationId: namespaceOrgId,
  });

  if (orgChanged) {
    console.log(
      `[PaprLogin] Synced profile to workspace ${active.workspaceName} namespace org ${namespaceOrgId}`,
    );
    const updatedProfile = settingsStorage.getPaprProfile()!;
    await syncNamespaceApiKeyIfNeeded({
      profile: updatedProfile,
      organizationId: namespaceOrgId,
      preferredNamespaceId:
        readActiveWorkspacePointer()?.namespaceId ?? profile.activeNamespaceId,
      customKeysStorage,
      settingsStorage,
    });
  } else {
    invalidateKeyCache();
    console.log(
      `[PaprLogin] Synced profile workspace metadata for ${active.workspaceName}`,
    );
  }

  return active;
}

async function fetchUserWorkspacesWithRefresh(
  profile: PaprProfile,
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage,
): Promise<UserWorkspaceOption[]> {
  const graphql: GraphQLExecutor = (query, variables) =>
    parseGraphQLWithRefresh(
      profile.sessionToken!,
      query,
      variables,
      customKeysStorage,
      settingsStorage,
    );

  return fetchUserWorkspaces(profile.userId!, graphql);
}

type PaprProfile = NonNullable<ReturnType<SettingsStorage["getPaprProfile"]>>;

// User's developer org (user.organization_id) — fallback only when no workspace is selected
const GET_USER_DEVELOPER_ORG = `
  query GetUserDeveloperOrg($userId: ID!) {
    user(id: $userId) {
      organization_id
    }
  }
`;

async function fetchUserDeveloperOrganizationId(
  sessionToken: string,
  userId: string,
): Promise<string | undefined> {
  const data = (await parseGraphQL(sessionToken, GET_USER_DEVELOPER_ORG, { userId })) as {
    user?: { organization_id?: string };
  };
  const orgId = data.user?.organization_id as string | undefined;
  return orgId?.trim() || undefined;
}

async function resolveOrganizationIdForProfile(
  profile: PaprProfile,
): Promise<string | undefined> {
  if (profile.sessionToken && profile.userId) {
    try {
      const graphql: GraphQLExecutor = (query, variables) =>
        parseGraphQL(profile.sessionToken!, query, variables);
      const workspaces = await fetchUserWorkspaces(profile.userId, graphql);
      if (profile.workspaceId) {
        const active = workspaces.find(
          (workspace) => workspace.workspaceId === profile.workspaceId,
        );
        if (active?.organizationId) {
          return active.organizationId;
        }
      }
      const selected = workspaces.find((workspace) => workspace.isSelected);
      if (selected?.organizationId) {
        return selected.organizationId;
      }
    } catch (error) {
      console.warn("[PaprLogin] Could not resolve namespace org from workspaces:", error);
    }
  }

  if (profile.organizationId) {
    return profile.organizationId;
  }

  if (profile.sessionToken && profile.userId) {
    try {
      const developerOrgId = await fetchUserDeveloperOrganizationId(
        profile.sessionToken,
        profile.userId,
      );
      if (developerOrgId) {
        return developerOrgId;
      }
    } catch (error) {
      console.warn("[PaprLogin] Could not resolve user.organization_id:", error);
    }
  }

  return undefined;
}

async function switchSelectedWorkspaceOnServer(input: {
  sessionToken: string;
  userId: string;
  targetFollowerId: string;
  previousFollowerId?: string;
}): Promise<void> {
  if (input.previousFollowerId && input.previousFollowerId !== input.targetFollowerId) {
    await parseGraphQL(input.sessionToken, UPDATE_WORKSPACE_FOLLOWER_SELECTION, {
      input: {
        id: input.previousFollowerId,
        fields: {
          isSelected: false,
          user: { link: input.userId },
        },
      },
    });
  }

  await parseGraphQL(input.sessionToken, UPDATE_WORKSPACE_FOLLOWER_SELECTION, {
    input: {
      id: input.targetFollowerId,
      fields: {
        isSelected: true,
        user: { link: input.userId },
      },
    },
  });

  await parseGraphQL(input.sessionToken, UPDATE_USER_SELECTED_WORKSPACE, {
    input: {
      id: input.userId,
      fields: {
        isSelectedWorkspaceFollower: { link: input.targetFollowerId },
      },
    },
  });
}

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
  console.log("[PaprLogin] Provisioning org/namespace...");

  const orgName = deriveOrgName(userEmail);

  if (!workspaceId) {
    workspaceId = await getSelectedWorkspaceId(sessionToken, userId);
    if (workspaceId) {
      console.log(`[PaprLogin] Selected workspace: ${workspaceId}`);
    } else {
      console.log("[PaprLogin] No selected workspace — will create one");
    }
  }

  // 1. Resolve namespace org for selected workspace (team org or developer org)
  if (workspaceId) {
    try {
      const resolved = await resolveNamespaceOrganizationForWorkspace(
        sessionToken,
        userId,
        workspaceId,
      );
      if (resolved) {
        console.log(
          `[PaprLogin] Workspace ${workspaceId} → namespace org "${resolved.organizationName}" (${resolved.organizationId})`,
        );
        if (resolved.defaultNamespaceId) {
          return await resolveOrgApiKey(
            sessionToken,
            userId,
            resolved.organizationId,
            resolved.defaultNamespaceId,
            "default",
            workspaceId,
          );
        }

        console.log(
          `[PaprLogin] Namespace org ${resolved.organizationId} has no default namespace — creating one`,
        );
        return await createNamespaceAndKey(
          sessionToken,
          userId,
          resolved.organizationId,
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

  // 2. Fallback: user.organization_id (developer org without a linked workspace)
  try {
    const developerOrgId = await fetchUserDeveloperOrganizationId(sessionToken, userId);
    if (developerOrgId) {
      console.log(`[PaprLogin] User developer org: ${developerOrgId}`);
      const defaultNs = await resolveDefaultNamespaceForOrg(sessionToken, developerOrgId);
      if (defaultNs) {
        return await resolveOrgApiKey(
          sessionToken,
          userId,
          developerOrgId,
          defaultNs.namespaceId,
          defaultNs.namespaceName,
          workspaceId ?? "",
        );
      }
      console.log("[PaprLogin] Developer org has no default namespace — creating one");
      return await createNamespaceAndKey(
        sessionToken,
        userId,
        developerOrgId,
        orgName,
        workspaceId ?? "",
      );
    }
  } catch (devOrgErr) {
    console.warn("[PaprLogin] Developer org lookup failed:", devOrgErr);
  }

  // 3. No org on workspace — full provisioning (new org + namespace + key)
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
      const wsResult = (await parseGraphQL(sessionToken, `
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
      })) as {
        callCloudCode?: { result?: { workspace?: { objectId?: string } } };
      };

      const cloudResult = wsResult.callCloudCode?.result;
      if (cloudResult?.workspace?.objectId) {
        workspaceId = cloudResult.workspace.objectId as string;
        console.log(`[PaprLogin] Created workspace via cloud function: ${workspaceId}`);
      }
    } catch (wsCreateErr) {
      console.warn("[PaprLogin] Cloud function createWorkspace failed:", wsCreateErr);
    }
  }

  const createOrgData = (await parseGraphQL(sessionToken, CREATE_ORGANIZATION, {
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
  })) as { createOrganization: { organization: { objectId: string } } };

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

  const createNsData = (await parseGraphQL(sessionToken, CREATE_NAMESPACE, {
    name: nsName,
    organizationId: orgId,
    organizationIdString: orgId,
    environmentType: "development",
    isActive: true,
  })) as { createNamespace: { namespace: { objectId: string } } };

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
  const keyData = (await parseGraphQL(sessionToken, GET_NAMESPACE_API_KEYS, {
    namespaceId,
  })) as {
    aPIKeys?: { edges?: Array<{ node?: { key?: string } }> };
  };
  const existingKey = keyData.aPIKeys?.edges?.[0]?.node;
  if (existingKey?.key) {
    console.log("[PaprLogin] Reusing existing API key for namespace");
    return { apiKey: existingKey.key, organizationId: orgId, namespaceId, namespaceName };
  }

  console.log("[PaprLogin] No API key for namespace, creating one...");
  const newKey = await createApiKey(sessionToken, userId, orgId, namespaceId, workspaceId);
  return { apiKey: newKey, organizationId: orgId, namespaceId, namespaceName };
}

interface OrgNamespaceChoice {
  namespaceId: string;
  namespaceName: string;
}

/** Resolve org default namespace, falling back to first namespace in the org. */
async function resolveDefaultNamespaceForOrg(
  sessionToken: string,
  organizationId: string,
): Promise<OrgNamespaceChoice | null> {
  try {
    const data = (await parseGraphQL(sessionToken, GET_ORG_DEFAULT_NAMESPACE, {
      orgId: organizationId,
    })) as {
      organization?: { default_namespace?: { objectId: string; name?: string } };
    };
    const defaultNs = data.organization?.default_namespace as
      | { objectId: string; name?: string }
      | undefined;
    if (defaultNs?.objectId) {
      return {
        namespaceId: defaultNs.objectId,
        namespaceName: defaultNs.name || "default",
      };
    }
  } catch (err) {
    console.warn("[PaprLogin] Default namespace lookup failed:", err);
  }

  try {
    const data = (await parseGraphQL(sessionToken, GET_ORG_NAMESPACES, {
      orgId: organizationId,
    })) as {
      namespaces?: { edges?: Array<{ node?: { objectId: string; name?: string } }> };
    };
    const first = data.namespaces?.edges?.[0]?.node as
      | { objectId: string; name?: string }
      | undefined;
    if (first?.objectId) {
      return {
        namespaceId: first.objectId,
        namespaceName: first.name || "default",
      };
    }
  } catch (err) {
    console.warn("[PaprLogin] Namespace list fallback failed:", err);
  }

  return null;
}

interface OrgNamespaceListItem {
  id: string;
  name: string;
  environmentType?: string;
}

async function fetchOrgNamespaces(
  sessionToken: string,
  organizationId: string,
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage,
): Promise<OrgNamespaceListItem[]> {
  const data = (await parseGraphQLWithRefresh(
    sessionToken,
    GET_ORG_NAMESPACES,
    { orgId: organizationId },
    customKeysStorage,
    settingsStorage,
  )) as {
    namespaces?: {
      edges?: Array<{
        node: {
          objectId: string;
          name: string;
          environment_type?: string;
        };
      }>;
    };
  };

  const namespaces = (data.namespaces?.edges || []).map(
    (edge: {
      node: {
        objectId: string;
        name: string;
        environment_type?: string;
      };
    }) => ({
      id: edge.node.objectId,
      name: edge.node.name,
      environmentType: edge.node.environment_type,
    }),
  );

  cacheNamespacesForOrg(
    organizationId,
    namespaces.map((ns: OrgNamespaceListItem) => ({
      id: ns.id,
      name: ns.name,
      environmentType: ns.environmentType,
    })),
  );

  return namespaces;
}

async function resolveNamespaceForWorkspaceSwitch(input: {
  sessionToken: string;
  organizationId: string;
  preferredNamespaceId?: string;
  customKeysStorage: CustomKeysStorage;
  settingsStorage: SettingsStorage;
}): Promise<{ namespaces: OrgNamespaceListItem[]; choice: OrgNamespaceChoice | null }> {
  const namespaces = await fetchOrgNamespaces(
    input.sessionToken,
    input.organizationId,
    input.customKeysStorage,
    input.settingsStorage,
  );

  if (input.preferredNamespaceId) {
    const preferred = namespaces.find((ns) => ns.id === input.preferredNamespaceId);
    if (preferred) {
      return {
        namespaces,
        choice: { namespaceId: preferred.id, namespaceName: preferred.name },
      };
    }
  }

  try {
    const data = (await parseGraphQL(input.sessionToken, GET_ORG_DEFAULT_NAMESPACE, {
      orgId: input.organizationId,
    })) as {
      organization?: { default_namespace?: { objectId: string; name?: string } };
    };
    const defaultNs = data.organization?.default_namespace as
      | { objectId: string; name?: string }
      | undefined;
    if (defaultNs?.objectId) {
      return {
        namespaces,
        choice: {
          namespaceId: defaultNs.objectId,
          namespaceName: defaultNs.name || "default",
        },
      };
    }
  } catch (err) {
    console.warn("[PaprLogin] Default namespace lookup failed:", err);
  }

  const first = namespaces[0];
  if (first) {
    return {
      namespaces,
      choice: { namespaceId: first.id, namespaceName: first.name },
    };
  }

  return { namespaces, choice: null };
}

/** Switch API key, profile, gateway workspace, and notify renderer. */
async function applyActiveNamespaceSwitch(input: {
  profile: PaprProfile;
  organizationId: string;
  namespaceId: string;
  namespaceName: string;
  customKeysStorage: CustomKeysStorage;
  settingsStorage: SettingsStorage;
  /** When false, skip renderer IPC (caller sends a combined workspace event). */
  notifyRenderer?: boolean;
}): Promise<{ apiKey: string }> {
  await input.customKeysStorage.setActiveOrganization(input.organizationId);

  const pointer = readActiveWorkspacePointer();
  const pointerMatches =
    pointer?.organizationId === input.organizationId &&
    pointer?.namespaceId === input.namespaceId;

  const workspaceId =
    input.profile.workspaceId ||
    (await getSelectedWorkspaceId(input.profile.sessionToken!, input.profile.userId!)) ||
    "";

  let apiKey: string;

  if (pointerMatches) {
    const cachedKey = await resolveActivePaprApiKey(input.customKeysStorage);
    if (
      cachedKey &&
      paprApiKeyMatchesNamespace(
        cachedKey,
        input.organizationId,
        input.namespaceId,
      )
    ) {
      apiKey = cachedKey;
    } else {
      const refreshed = await refreshActiveNamespaceApiKey({
        customKeysStorage: input.customKeysStorage,
        settingsStorage: input.settingsStorage,
        organizationId: input.organizationId,
        namespaceId: input.namespaceId,
        namespaceName: input.namespaceName,
      });
      if (!refreshed) {
        throw new Error("Failed to refresh namespace API key");
      }
      apiKey = refreshed;
    }
  } else {
    const resolved = await resolveOrgApiKey(
      input.profile.sessionToken!,
      input.profile.userId!,
      input.organizationId,
      input.namespaceId,
      input.namespaceName,
      workspaceId,
    );
    apiKey = resolved.apiKey;

    const workspaceResult = await notifyGatewayWorkspaceSwitch({
      organizationId: input.organizationId,
      namespaceId: input.namespaceId,
      namespaceName: input.namespaceName,
      paprApiKey: apiKey,
    });
    if (!workspaceResult.success) {
      throw new Error(
        workspaceResult.error ?? "Gateway workspace switch failed",
      );
    }
  }

  await persistNamespaceApiKeys(
    input.customKeysStorage,
    input.namespaceId,
    apiKey,
  );

  input.settingsStorage.setPaprProfile({
    ...input.profile,
    organizationId: input.organizationId,
    activeNamespaceId: input.namespaceId,
    activeNamespaceName: input.namespaceName,
  });

  invalidateKeyCache("PAPR_API_KEY");

  // When pointer already matched, gateway was not reloaded — push key + reinit storage.
  if (pointerMatches) {
    await notifyGatewayPaprApiKeyUpdate(apiKey);
  }

  if (input.notifyRenderer !== false) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("papr:namespace-changed", {
        namespaceId: input.namespaceId,
        namespaceName: input.namespaceName,
      });
    }
  }

  return { apiKey };
}

/** Fetch + persist namespace API key without reloading gateway workspace services. */
async function refreshActiveNamespaceApiKey(input: {
  customKeysStorage: CustomKeysStorage;
  settingsStorage: SettingsStorage;
  organizationId: string;
  namespaceId: string;
  namespaceName: string;
}): Promise<string | null> {
  const auth = await resolvePaprAuthContext(
    input.customKeysStorage,
    input.settingsStorage,
  );
  if (!auth) {
    return null;
  }

  const { profile, sessionToken } = auth;
  await input.customKeysStorage.setActiveOrganization(input.organizationId);

  const workspaceId =
    profile.workspaceId ||
    (await getSelectedWorkspaceId(sessionToken, profile.userId!)) ||
    "";

  const resolved = await resolveOrgApiKey(
    sessionToken,
    profile.userId!,
    input.organizationId,
    input.namespaceId,
    input.namespaceName,
    workspaceId,
  );

  await persistNamespaceApiKeys(
    input.customKeysStorage,
    input.namespaceId,
    resolved.apiKey,
  );

  input.settingsStorage.setPaprProfile({
    ...profile,
    organizationId: input.organizationId,
    activeNamespaceId: input.namespaceId,
    activeNamespaceName: input.namespaceName,
  });

  await notifyGatewayPaprApiKeyUpdate(resolved.apiKey);
  invalidateKeyCache("PAPR_API_KEY");

  return resolved.apiKey;
}

async function resolvePaprAuthContext(
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage,
): Promise<{ profile: NonNullable<ReturnType<SettingsStorage["getPaprProfile"]>>; sessionToken: string } | null> {
  const profile = settingsStorage.getPaprProfile();
  if (!profile?.userId) {
    return null;
  }

  const sessionToken =
    profile.sessionToken?.trim() ||
    (await customKeysStorage.getKeyByName("PAPR_SESSION_TOKEN"))?.trim() ||
    "";
  if (!sessionToken) {
    return null;
  }

  return { profile, sessionToken };
}

async function persistNamespaceApiKeys(
  customKeysStorage: CustomKeysStorage,
  namespaceId: string,
  apiKey: string,
): Promise<void> {
  await customKeysStorage.addKey({
    name: paprNamespaceApiKeyName(namespaceId),
    value: apiKey,
    orgScope: "organization",
  });
  await customKeysStorage.addKey({
    name: "PAPR_API_KEY",
    value: apiKey,
    orgScope: "organization",
  });
}

/** Resolve the Papr API key for the active workspace pointer (namespace cache first). */
export async function resolveActivePaprApiKey(
  customKeysStorage: CustomKeysStorage,
): Promise<string | null> {
  const pointer = readActiveWorkspacePointer();
  if (!pointer) {
    return customKeysStorage.getKeyByName("PAPR_API_KEY");
  }

  await customKeysStorage.setActiveOrganization(pointer.organizationId);

  const namespaceSlot = paprNamespaceApiKeyName(pointer.namespaceId);
  const cachedForNamespace = await customKeysStorage.getKeyByName(namespaceSlot);
  if (cachedForNamespace?.trim()) {
    return cachedForNamespace.trim();
  }

  const activeAlias = await customKeysStorage.getKeyByName("PAPR_API_KEY");
  if (
    activeAlias &&
    paprApiKeyMatchesNamespace(
      activeAlias,
      pointer.organizationId,
      pointer.namespaceId,
    )
  ) {
    return activeAlias;
  }

  return null;
}

/**
 * Resolve and store the namespace API key when org/namespace context changes.
 * Skips network + gateway work when the stored key already matches.
 */
async function syncNamespaceApiKeyIfNeeded(input: {
  profile: PaprProfile;
  organizationId: string;
  preferredNamespaceId?: string;
  customKeysStorage: CustomKeysStorage;
  settingsStorage: SettingsStorage;
  force?: boolean;
}): Promise<void> {
  const auth = await resolvePaprAuthContext(
    input.customKeysStorage,
    input.settingsStorage,
  );
  if (!auth) {
    invalidateKeyCache("PAPR_API_KEY");
    return;
  }

  const { profile, sessionToken } = auth;

  await input.customKeysStorage.setActiveOrganization(input.organizationId);

  const pointer = readActiveWorkspacePointer();
  const preferredNamespaceId =
    pointer?.organizationId === input.organizationId
      ? pointer.namespaceId
      : input.preferredNamespaceId;

  const { choice } = await resolveNamespaceForWorkspaceSwitch({
    sessionToken,
    organizationId: input.organizationId,
    preferredNamespaceId,
    customKeysStorage: input.customKeysStorage,
    settingsStorage: input.settingsStorage,
  });

  if (!choice) {
    invalidateKeyCache("PAPR_API_KEY");
    input.settingsStorage.setPaprProfile({
      ...input.settingsStorage.getPaprProfile()!,
      activeNamespaceId: undefined,
      activeNamespaceName: undefined,
    });
    return;
  }

  if (!input.force) {
    const storedKey = await resolveActivePaprApiKey(input.customKeysStorage);
    const currentProfile = input.settingsStorage.getPaprProfile();
    const pointerMatches =
      pointer?.organizationId === input.organizationId &&
      pointer?.namespaceId === choice.namespaceId;
    if (
      storedKey &&
      paprApiKeyMatchesNamespace(
        storedKey,
        input.organizationId,
        choice.namespaceId,
      ) &&
      currentProfile?.activeNamespaceId === choice.namespaceId &&
      currentProfile.organizationId === input.organizationId &&
      pointerMatches
    ) {
      return;
    }
  }

  if (
    pointer?.organizationId === input.organizationId &&
    pointer?.namespaceId === choice.namespaceId
  ) {
    await refreshActiveNamespaceApiKey({
      customKeysStorage: input.customKeysStorage,
      settingsStorage: input.settingsStorage,
      organizationId: input.organizationId,
      namespaceId: choice.namespaceId,
      namespaceName: choice.namespaceName,
    });
    input.settingsStorage.setPaprProfile({
      ...input.settingsStorage.getPaprProfile()!,
      organizationId: input.organizationId,
      activeNamespaceId: choice.namespaceId,
      activeNamespaceName: choice.namespaceName,
    });
    return;
  }

  await applyActiveNamespaceSwitch({
    profile: { ...profile, organizationId: input.organizationId },
    organizationId: input.organizationId,
    namespaceId: choice.namespaceId,
    namespaceName: choice.namespaceName,
    customKeysStorage: input.customKeysStorage,
    settingsStorage: input.settingsStorage,
  });
}

let ensureActiveNamespaceApiKeyInFlight: Promise<string | null> | null = null;

/** Ensure startup uses the API key for the active workspace pointer (not just profile). */
export async function ensureActiveNamespaceApiKey(
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage,
): Promise<string | null> {
  if (ensureActiveNamespaceApiKeyInFlight) {
    return ensureActiveNamespaceApiKeyInFlight;
  }

  ensureActiveNamespaceApiKeyInFlight = ensureActiveNamespaceApiKeyInternal(
    customKeysStorage,
    settingsStorage,
  ).finally(() => {
    ensureActiveNamespaceApiKeyInFlight = null;
  });

  return ensureActiveNamespaceApiKeyInFlight;
}

async function ensureActiveNamespaceApiKeyInternal(
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage,
): Promise<string | null> {
  const auth = await resolvePaprAuthContext(customKeysStorage, settingsStorage);
  if (!auth) {
    return null;
  }

  const { profile } = auth;

  const pointer = readActiveWorkspacePointer();
  const organizationId = pointer?.organizationId ?? profile.organizationId;
  const namespaceId = pointer?.namespaceId ?? profile.activeNamespaceId;
  if (!organizationId || !namespaceId) {
    return null;
  }

  const namespaceName =
    pointer?.namespaceName ?? profile.activeNamespaceName ?? namespaceId;

  await customKeysStorage.setActiveOrganization(organizationId);

  const storedKey = await resolveActivePaprApiKey(customKeysStorage);
  if (storedKey) {
    await notifyGatewayPaprApiKeyUpdate(storedKey);
    invalidateKeyCache("PAPR_API_KEY");
    return storedKey;
  }

  console.log(
    `[PaprLogin] PAPR_API_KEY out of sync with active workspace (${namespaceId}) — refreshing…`,
  );

  return refreshActiveNamespaceApiKey({
    customKeysStorage,
    settingsStorage,
    organizationId,
    namespaceId,
    namespaceName,
  });
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

  const keyData = (await parseGraphQL(sessionToken, CREATE_API_KEY, {
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
  })) as { createAPIKey: { aPIKey: { key: string } } };

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
  const userData = (await parseGraphQL(sessionToken, GET_USER_WORKSPACE, { userId })) as {
    user?: {
      isSelectedWorkspaceFollower?: {
        workspace?: {
          objectId?: string;
          workspace_name?: string;
          organization?: { objectId?: string; name?: string };
        };
      };
    };
  };
  const workspace = userData.user?.isSelectedWorkspaceFollower?.workspace;

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

  const developerOrgId = await fetchUserDeveloperOrganizationId(parseSessionToken, objectId);

  let namespaceOrganizationId: string | undefined;
  if (workspaceInfo.workspaceId) {
    const resolved = await resolveNamespaceOrganizationForWorkspace(
      parseSessionToken,
      objectId,
      workspaceInfo.workspaceId,
    );
    namespaceOrganizationId = resolved?.organizationId;
  }

  const activeOrganizationId = resolveLoginOrganizationId({
    namespaceOrganizationId,
    provisionOrganizationId: provision.organizationId,
    developerOrganizationId: developerOrgId,
  });
  if (!activeOrganizationId) {
    throw new Error("Could not resolve organization for Papr login");
  }

  let activeNamespaceId = provision.namespaceId;
  let activeNamespaceName = provision.namespaceName;
  if (activeOrganizationId !== provision.organizationId) {
    const workspaceNs = await resolveDefaultNamespaceForOrg(
      parseSessionToken,
      activeOrganizationId,
    );
    if (workspaceNs) {
      const workspaceKey = await resolveOrgApiKey(
        parseSessionToken,
        objectId,
        activeOrganizationId,
        workspaceNs.namespaceId,
        workspaceNs.namespaceName,
        workspaceInfo.workspaceId ?? "",
      );
      activeNamespaceId = workspaceKey.namespaceId;
      activeNamespaceName = workspaceKey.namespaceName;
      await customKeysStorage.addKey({
        name: "PAPR_API_KEY",
        value: workspaceKey.apiKey,
      });
    }
  }

  await customKeysStorage.setActiveOrganization(activeOrganizationId);

  if (activeOrganizationId === provision.organizationId) {
    await customKeysStorage.addKey({
      name: "PAPR_API_KEY",
      value: provision.apiKey,
    });
  }

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
    profileImage,
    authenticatedAt: new Date().toISOString(),
    sessionToken: parseSessionToken,
    organizationId: activeOrganizationId,
    activeNamespaceId,
    activeNamespaceName,
    workspaceId: workspaceInfo.workspaceId,
    workspaceName: workspaceInfo.workspaceName,
  });

  const loginApiKey =
    activeOrganizationId === provision.organizationId
      ? provision.apiKey
      : (await resolveActivePaprApiKey(customKeysStorage)) ?? provision.apiKey;

  const workspaceResult = await notifyGatewayWorkspaceSwitch({
    organizationId: activeOrganizationId,
    namespaceId: activeNamespaceId,
    namespaceName: activeNamespaceName,
    paprApiKey: loginApiKey,
  });
  if (!workspaceResult.success) {
    throw new Error(
      workspaceResult.error ?? "Gateway workspace switch failed",
    );
  }
  invalidateKeyCache("PAPR_API_KEY");

  await syncProfileToGatewaySettings(
    email || "",
    objectId,
    displayName || "",
    profileImage,
    activeNamespaceName,
    workspaceInfo.workspaceId,
    workspaceInfo.workspaceName,
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
  registerPaprWorkspaceHandlers();
  registerPaprLegacyMigrationHandlers({
    resolvePaprApiKey: async () => {
      try {
        const key = await customKeysStorage.getKey("PAPR_API_KEY");
        return key?.trim() || undefined;
      } catch {
        return undefined;
      }
    },
  });
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

  ipcMain.handle("papr:refresh-profile", async () => {
    try {
      const profile = settingsStorage.getPaprProfile();
      if (!profile?.sessionToken || !profile.userId) {
        return { success: true, profile: undefined };
      }

      const { fetchParseUserProfile } = await import("./paprProfileSync.js");
      const cloudProfile = await fetchParseUserProfile(
        profile.sessionToken,
        profile.userId,
      );

      settingsStorage.setPaprProfile({
        ...profile,
        email: cloudProfile.email || profile.email,
        displayName:
          cloudProfile.displayName || cloudProfile.fullname || profile.displayName,
        profileImage: cloudProfile.profileImageUrl || profile.profileImage,
      });

      const updated = settingsStorage.getPaprProfile();
      if (!updated) {
        return { success: true, profile: undefined };
      }

      const { sessionToken: _sessionToken, ...safeProfile } = updated;
      return { success: true, profile: safeProfile };
    } catch (error) {
      console.warn("[PaprLogin] Failed to refresh profile from Parse:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  ipcMain.handle(
    "papr:sync-profile",
    async (
      _event,
      input: { name?: string; email?: string; imageUrl?: string },
    ) => {
      try {
        const profile = settingsStorage.getPaprProfile();
        if (!profile?.sessionToken || !profile.userId) {
          return {
            success: false,
            error: "Not logged in to Papr",
          };
        }

        const { syncProfileToParse } = await import("./paprProfileSync.js");
        const syncResult = await syncProfileToParse({
          sessionToken: profile.sessionToken,
          userId: profile.userId,
          name: input.name,
          email: input.email,
          imageUrl: input.imageUrl,
        });

        const nextProfileImage =
          syncResult.profileImageUrl || profile.profileImage;
        settingsStorage.setPaprProfile({
          ...profile,
          displayName: input.name?.trim() || profile.displayName,
          profileImage: nextProfileImage,
        });

        if (syncResult.syncedImageUrl) {
          await syncProfileToGatewaySettings(
            input.email?.trim() || profile.email,
            profile.userId,
            input.name?.trim() || profile.displayName,
            syncResult.syncedImageUrl,
            profile.activeNamespaceName,
            profile.workspaceId,
            profile.workspaceName,
          );
        }

        return {
          success: true,
          profileImageUrl: nextProfileImage,
          syncedImageUrl: syncResult.syncedImageUrl,
        };
      } catch (error) {
        console.warn("[PaprLogin] Failed to sync profile to Parse:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

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

  // List namespaces for a workspace's organization (explicit org id avoids profile timing races)
  ipcMain.handle(
    "papr:list-namespaces",
    async (
      _event,
      options?: { organizationId?: string; forceRefresh?: boolean; peek?: boolean },
    ) => {
      try {
        const profile = settingsStorage.getPaprProfile();
        if (!profile?.sessionToken) {
          return { success: false, error: "Not logged in" };
        }

        const organizationId =
          options?.organizationId?.trim() ||
          (await resolveOrganizationIdForProfile(profile));
        if (!organizationId) {
          return { success: false, error: "Missing organization info" };
        }

        const peek = options?.peek === true;
        if (!peek && organizationId !== profile.organizationId) {
          settingsStorage.setPaprProfile({ ...profile, organizationId });
        }

        const forceRefresh = options?.forceRefresh === true;
        const cached = forceRefresh ? null : getCachedNamespaces(organizationId);
        if (cached) {
          void fetchOrgNamespaces(
            profile.sessionToken,
            organizationId,
            customKeysStorage,
            settingsStorage,
          ).catch((error) => {
            console.warn("[PaprLogin] Background namespace refresh failed:", error);
          });

          return {
            success: true,
            namespaces: cached,
            activeNamespaceId: profile.activeNamespaceId,
            parseOrganizationId: organizationId,
            fromCache: true,
          };
        }

        const namespaces = await fetchOrgNamespaces(
          profile.sessionToken,
          organizationId,
          customKeysStorage,
          settingsStorage,
        );

        console.log(
          `[PaprLogin] Listed ${namespaces.length} namespaces for org ${organizationId}`,
        );

        return {
          success: true,
          namespaces,
          activeNamespaceId: profile.activeNamespaceId,
          parseOrganizationId: organizationId,
        };
      } catch (error) {
        console.error("[PaprLogin] Failed to list namespaces:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to list namespaces",
        };
      }
    },
  );

  // List workspaces (dashboard uses workspace_follower → organization name for display)
  ipcMain.handle("papr:list-organizations", async () => {
    try {
      const profile = settingsStorage.getPaprProfile();
      if (!profile?.sessionToken || !profile?.userId) {
        return { success: false, error: "Not logged in" };
      }

      const diskCache = readPaprWorkspaceCache();
      const cachedWorkspaces = diskCache?.workspaces ?? [];

      const buildResponse = (
        workspaces: UserWorkspaceOption[],
        fromCache: boolean,
      ) => {
        const organizations = workspaces.map((workspace) => ({
          id: workspace.workspaceId,
          name: workspaceDisplayName(workspace),
          role: workspace.role,
          organizationId: workspace.organizationId,
          organizationName: workspace.organizationName,
          workspaceName: workspace.workspaceName,
          defaultNamespaceId: workspace.defaultNamespaceId,
        }));

        const selected = workspaces.find((workspace) => workspace.isSelected);
        const activeWorkspaceId =
          profile.workspaceId || selected?.workspaceId || workspaces[0]?.workspaceId;

        return {
          success: true as const,
          organizations,
          activeOrganizationId: activeWorkspaceId,
          fromCache,
        };
      };

      if (cachedWorkspaces.length > 0) {
        void fetchUserWorkspacesWithRefresh(profile, customKeysStorage, settingsStorage)
          .then(async (workspaces) => {
            writePaprWorkspaceCache({
              workspaces: workspaces.map(
                (workspace): CachedWorkspace => ({
                  id: workspace.workspaceId,
                  name: workspaceDisplayName(workspace),
                  role: workspace.role,
                  organizationId: workspace.organizationId,
                  organizationName: workspace.organizationName,
                  workspaceName: workspace.workspaceName,
                  defaultNamespaceId: workspace.defaultNamespaceId,
                }),
              ),
            });

            const active = await syncActiveWorkspaceOrganization(
              profile,
              workspaces,
              settingsStorage,
              customKeysStorage,
            );
            if (active?.organizationId && profile.sessionToken) {
              try {
                const namespaces = await fetchOrgNamespaces(
                  profile.sessionToken,
                  active.organizationId,
                  customKeysStorage,
                  settingsStorage,
                );
                console.log(
                  `[PaprLogin] Prefetched ${namespaces.length} namespaces for org ${active.organizationId}`,
                );
              } catch (error) {
                console.warn("[PaprLogin] Background namespace prefetch failed:", error);
              }
            }
          })
          .catch((error) => {
            console.warn("[PaprLogin] Background workspace refresh failed:", error);
          });

        const workspacesFromCache: UserWorkspaceOption[] = cachedWorkspaces.map(
          (workspace) => ({
            followerId: "",
            workspaceId: workspace.id,
            workspaceName: workspace.workspaceName ?? workspace.name,
            organizationId: workspace.organizationId ?? "",
            organizationName: workspace.organizationName ?? workspace.name,
            isSelected: workspace.id === profile.workspaceId,
            role: workspace.role ?? "member",
            defaultNamespaceId: workspace.defaultNamespaceId,
          }),
        );

        await syncActiveWorkspaceOrganization(
          profile,
          workspacesFromCache,
          settingsStorage,
          customKeysStorage,
        );

        return buildResponse(workspacesFromCache, true);
      }

      const workspaces = await fetchUserWorkspacesWithRefresh(
        profile,
        customKeysStorage,
        settingsStorage,
      );

      writePaprWorkspaceCache({
        workspaces: workspaces.map(
          (workspace): CachedWorkspace => ({
            id: workspace.workspaceId,
            name: workspaceDisplayName(workspace),
            role: workspace.role,
            organizationId: workspace.organizationId,
            organizationName: workspace.organizationName,
            workspaceName: workspace.workspaceName,
            defaultNamespaceId: workspace.defaultNamespaceId,
          }),
        ),
      });

      const selected = workspaces.find((workspace) => workspace.isSelected);
      const activeWorkspaceId =
        profile.workspaceId || selected?.workspaceId || workspaces[0]?.workspaceId;

      if (activeWorkspaceId) {
        await syncActiveWorkspaceOrganization(
          profile,
          workspaces,
          settingsStorage,
          customKeysStorage,
        );
      }

      console.log(
        `[PaprLogin] Found ${workspaces.length} workspaces:`,
        workspaces
          .map(
            (workspace) =>
              `${workspace.workspaceName ?? workspace.organizationName} (org: ${workspace.organizationName})`,
          )
          .join(", "),
      );

      return buildResponse(workspaces, false);
    } catch (error) {
      console.error("[PaprLogin] Failed to list organizations:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list workspaces",
      };
    }
  });

  // Switch workspace (updates Parse selection, then default namespace for that org)
  ipcMain.handle("papr:switch-organization", async (_event, workspaceId: string, displayName: string) => {
    try {
      const profile = settingsStorage.getPaprProfile();
      if (!profile?.sessionToken || !profile?.userId) {
        return { success: false, error: "Not logged in" };
      }

      const workspaces = await fetchUserWorkspacesWithRefresh(
        profile,
        customKeysStorage,
        settingsStorage,
      );
      const target = workspaces.find((workspace) => workspace.workspaceId === workspaceId);
      if (!target) {
        return { success: false, error: "Workspace not found" };
      }

      const previous =
        workspaces.find((workspace) => workspace.isSelected) ??
        workspaces.find((workspace) => workspace.workspaceId === profile.workspaceId);

      await switchSelectedWorkspaceOnServer({
        sessionToken: profile.sessionToken,
        userId: profile.userId,
        targetFollowerId: target.followerId,
        previousFollowerId: previous?.followerId,
      });

      const updatedProfile = {
        ...profile,
        workspaceId: target.workspaceId,
        workspaceName: target.workspaceName,
      };
      settingsStorage.setPaprProfile(updatedProfile);

      const namespaceOrgId = target.organizationId;
      if (!namespaceOrgId) {
        return { success: false, error: "Could not resolve organization for namespaces" };
      }

      settingsStorage.setPaprProfile({
        ...updatedProfile,
        organizationId: namespaceOrgId,
      });

      await customKeysStorage.setActiveOrganization(namespaceOrgId);
      invalidateKeyCache();

      console.log(
        `[PaprLogin] Switched to workspace: ${displayName} (workspace ${target.workspaceId}, namespace org ${namespaceOrgId}, workspace org ${target.organizationId})`,
      );

      const { namespaces, choice: defaultNs } = await resolveNamespaceForWorkspaceSwitch({
        sessionToken: profile.sessionToken,
        organizationId: namespaceOrgId,
        preferredNamespaceId: target.defaultNamespaceId,
        customKeysStorage,
        settingsStorage,
      });

      const win = BrowserWindow.getAllWindows()[0];

      if (!defaultNs) {
        settingsStorage.setPaprProfile({
          ...settingsStorage.getPaprProfile()!,
          activeNamespaceId: undefined,
          activeNamespaceName: undefined,
        });

        if (win) {
          win.webContents.send("papr:organization-changed", {
            organizationId: target.workspaceId,
            parseOrganizationId: namespaceOrgId,
            organizationName: displayName,
            namespaces,
          });
        }

        return {
          success: true,
          organizationId: target.workspaceId,
          parseOrganizationId: namespaceOrgId,
          organizationName: displayName,
          namespaces,
        };
      }

      const { apiKey } = await applyActiveNamespaceSwitch({
        profile: { ...updatedProfile, organizationId: namespaceOrgId },
        organizationId: namespaceOrgId,
        namespaceId: defaultNs.namespaceId,
        namespaceName: defaultNs.namespaceName,
        customKeysStorage,
        settingsStorage,
        notifyRenderer: false,
      });

      console.log(
        `[PaprLogin] Auto-selected default namespace: ${defaultNs.namespaceName} (${defaultNs.namespaceId})`,
      );

      if (win) {
        win.webContents.send("papr:organization-changed", {
          organizationId: target.workspaceId,
          parseOrganizationId: namespaceOrgId,
          organizationName: displayName,
          namespaceId: defaultNs.namespaceId,
          namespaceName: defaultNs.namespaceName,
          namespaces,
        });
      }

      return {
        success: true,
        organizationId: target.workspaceId,
        parseOrganizationId: namespaceOrgId,
        organizationName: displayName,
        namespaces,
        activeNamespaceId: defaultNs.namespaceId,
        activeNamespaceName: defaultNs.namespaceName,
        apiKey,
      };
    } catch (error) {
      console.error("[PaprLogin] Failed to switch organization:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to switch workspace",
      };
    }
  });

  // Switch to a different namespace — gets or creates API key for it
  ipcMain.handle("papr:switch-namespace", async (_event, namespaceId: string, namespaceName: string) => {
    try {
      const profile = settingsStorage.getPaprProfile();
      if (!profile?.sessionToken || !profile?.userId) {
        return { success: false, error: "Not logged in or missing org info" };
      }

      const organizationId = await resolveOrganizationIdForProfile(profile);
      if (!organizationId) {
        return { success: false, error: "Missing organization info" };
      }

      const { apiKey } = await applyActiveNamespaceSwitch({
        profile,
        organizationId,
        namespaceId,
        namespaceName,
        customKeysStorage,
        settingsStorage,
      });

      console.log(`[PaprLogin] Switched to namespace: ${namespaceName} (${namespaceId})`);

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

  registerPaprBillingHandlers({
    settingsStorage,
    runGraphQLWithRefresh: async (query, variables) => {
      const profile = settingsStorage.getPaprProfile();
      if (!profile?.sessionToken) {
        throw new Error("Connect your Papr account to manage billing.");
      }
      return (await parseGraphQLWithRefresh(
        profile.sessionToken,
        query,
        variables,
        customKeysStorage,
        settingsStorage,
      )) as Record<string, unknown>;
    },
  });

  // Startup sync runs from index.cjs before Gateway spawn (see ensureActiveNamespaceApiKey export).
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
