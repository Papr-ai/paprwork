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
import * as crypto from "crypto";

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

interface PaprLoginState {
  pendingState?: string;
  codeVerifier?: string;
}

const loginState: PaprLoginState = {};

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
    updateWorkspace(
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

// Query to check if user already has an organization
const GET_USER_ORGANIZATION = `
  query GetUserOrganization($userId: ID!) {
    organizations(where: { owner: { have: { objectId: { equalTo: $userId } } } }) {
      edges {
        node {
          objectId
          name
          default_namespace {
            objectId
            name
          }
          workspace {
            objectId
          }
        }
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

// Query to get ALL namespaces for an organization
const GET_ORG_NAMESPACES = `
  query GetOrgNamespaces($orgId: ID!) {
    namespaces(where: { organization: { have: { objectId: { equalTo: $orgId } } }, is_active: { equalTo: true } }) {
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
  console.log("[PaprLogin] Checking for existing organization...");

  // 1. Check for existing organization
  const orgData = await parseGraphQL(sessionToken, GET_USER_ORGANIZATION, {
    userId,
  });

  const existingOrg = orgData.organizations?.edges?.[0]?.node;

  if (existingOrg && existingOrg.default_namespace) {
    console.log(`[PaprLogin] Found existing org: ${existingOrg.objectId}`);

    // Check for existing API key
    const keyData = await parseGraphQL(sessionToken, GET_NAMESPACE_API_KEYS, {
      namespaceId: existingOrg.default_namespace.objectId,
    });

    const existingKey = keyData.aPIKeys?.edges?.[0]?.node;
    if (existingKey?.key) {
      console.log("[PaprLogin] Found existing API key");
      return {
        apiKey: existingKey.key,
        organizationId: existingOrg.objectId,
        namespaceId: existingOrg.default_namespace.objectId,
        namespaceName: existingOrg.default_namespace.name || "default",
      };
    }

    // Org exists but no API key — create one
    console.log("[PaprLogin] Org exists but no API key, creating one...");
    const newKey = await createApiKey(
      sessionToken,
      userId,
      existingOrg.objectId,
      existingOrg.default_namespace.objectId,
      existingOrg.workspace?.objectId || workspaceId || "",
    );
    return {
      apiKey: newKey,
      organizationId: existingOrg.objectId,
      namespaceId: existingOrg.default_namespace.objectId,
      namespaceName: existingOrg.default_namespace.name || "default",
    };
  }

  // 2. No org — full provisioning
  console.log("[PaprLogin] No organization found, provisioning...");

  const orgName = userEmail.includes("@")
    ? userEmail.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "-")
    : "default";

  // Create organization
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

  const orgId = createOrgData.createOrganization.organization.objectId;
  console.log(`[PaprLogin] Created organization: ${orgId}`);

  // Create namespace
  const createNsData = await parseGraphQL(sessionToken, CREATE_NAMESPACE, {
    name: `${orgName}-dev`,
    organizationId: orgId,
    organizationIdString: orgId,
    environmentType: "development",
    isActive: true,
  });

  const nsId = createNsData.createNamespace.namespace.objectId;
  console.log(`[PaprLogin] Created namespace: ${nsId}`);

  // Link namespace as default + link workspace to org
  await parseGraphQL(sessionToken, UPDATE_ORG_DEFAULT_NAMESPACE, {
    organizationId: orgId,
    defaultNamespaceId: nsId,
  });

  if (workspaceId) {
    await parseGraphQL(sessionToken, UPDATE_WORKSPACE_ORG, {
      workspaceId,
      organizationId: orgId,
    });
  }

  // Create API key
  const key = await createApiKey(sessionToken, userId, orgId, nsId, workspaceId || "");
  return {
    apiKey: key,
    organizationId: orgId,
    namespaceId: nsId,
    namespaceName: `${orgName}-dev`,
  };
}

async function createApiKey(
  sessionToken: string,
  userId: string,
  orgId: string,
  nsId: string,
  workspaceId: string,
): Promise<string> {
  const apiKeyValue = generateApiKey(orgId, nsId);
  const roleName = `member-${workspaceId}`;

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
        }
      }
    }
  }
`;

// ─── IPC Handlers ──────────────────────────────────────────────

export function initializePaprLoginIPC(
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage,
) {
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

  // Start PKCE login flow
  ipcMain.handle("papr:start-login", async () => {
    try {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateState();

      loginState.pendingState = state;
      loginState.codeVerifier = codeVerifier;

      const authUrl = new URL(`https://${AUTH0_DOMAIN}/authorize`);
      authUrl.searchParams.set("client_id", AUTH0_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", AUTH0_REDIRECT_URI);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("scope", AUTH0_SCOPE);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("audience", `https://${AUTH0_DOMAIN}/userinfo`);

      await shell.openExternal(authUrl.toString());

      return { success: true };
    } catch (error) {
      loginState.pendingState = undefined;
      loginState.codeVerifier = undefined;
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to start login",
      };
    }
  });

  // Handle the deep link callback
  ipcMain.handle("papr:handle-callback", async (_event, callbackUrl: string) => {
    try {
      const url = new URL(callbackUrl);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        throw new Error(
          `Auth0 error: ${error} - ${url.searchParams.get("error_description") || ""}`,
        );
      }

      if (!code) throw new Error("No authorization code received");
      if (!state || state !== loginState.pendingState) {
        throw new Error("Invalid state parameter — possible CSRF attack");
      }
      if (!loginState.codeVerifier) {
        throw new Error("No code verifier found — login flow may have expired");
      }

      // Exchange code for tokens
      console.log("[PaprLogin] Exchanging authorization code for tokens...");
      const tokens = await exchangeCodeForTokens(code, loginState.codeVerifier);

      // Clear login state
      loginState.pendingState = undefined;
      loginState.codeVerifier = undefined;

      // Decode ID token to extract Parse session token and user info
      if (!tokens.id_token) {
        throw new Error("No ID token received from Auth0");
      }

      const claims = decodeIdToken(tokens.id_token);
      const parseSessionToken = claims["https://papr.scope.com/sessionToken"];
      const objectId = claims["https://papr.scope.com/objectId"];
      const displayName =
        claims["https://papr.scope.com/displayName"] || claims.nickname || claims.name;
      const email = claims.email;

      if (!parseSessionToken || !objectId) {
        throw new Error(
          "Missing Parse session token or objectId in Auth0 claims. " +
            "Auth0 Actions may not have run correctly.",
        );
      }

      console.log(`[PaprLogin] Authenticated user: ${email} (${objectId})`);

      // Get user's workspace ID
      let workspaceId: string | undefined;
      try {
        const userData = await parseGraphQL(parseSessionToken, GET_USER_WORKSPACE, {
          userId: objectId,
        });
        workspaceId = userData.user?.isSelectedWorkspaceFollower?.workspace?.objectId;
      } catch (e) {
        console.warn("[PaprLogin] Could not fetch workspace ID:", e);
      }

      // Provision org/namespace/API key or retrieve existing one
      const provision = await provisionOrGetApiKey(
        parseSessionToken,
        objectId,
        email || "user",
        workspaceId,
      );

      // Store the API key as PAPR_API_KEY (same key the rest of the app expects)
      await customKeysStorage.addKey({
        name: "PAPR_API_KEY",
        value: provision.apiKey,
      });

      // Also store the session token for later namespace queries
      await customKeysStorage.addKey({
        name: "PAPR_SESSION_TOKEN",
        value: parseSessionToken,
      });

      // Store refresh token for automatic session renewal
      if (tokens.refresh_token) {
        await customKeysStorage.addKey({
          name: "PAPR_REFRESH_TOKEN",
          value: tokens.refresh_token,
        });
      }

      // Save user profile with org/namespace info
      settingsStorage.setPaprProfile({
        userId: objectId,
        email: email || "",
        displayName: displayName || "",
        authenticatedAt: new Date().toISOString(),
        sessionToken: parseSessionToken,
        organizationId: provision.organizationId,
        activeNamespaceId: provision.namespaceId,
        activeNamespaceName: provision.namespaceName,
      });

      console.log("[PaprLogin] Login complete. API key stored as PAPR_API_KEY.");

      // Notify renderer
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send("papr:login-success", {
          email: email || "",
          name: displayName || "",
        });
      }

      return {
        success: true,
        email: email || "",
        name: displayName || "",
      };
    } catch (error) {
      loginState.pendingState = undefined;
      loginState.codeVerifier = undefined;
      console.error("[PaprLogin] Login failed:", error);

      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send("papr:login-error", {
          error: error instanceof Error ? error.message : "Login failed",
        });
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : "Login failed",
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

      // Clear PKCE state
      loginState.codeVerifier = undefined;
      loginState.pendingState = undefined;

      settingsStorage.clearPaprProfile();
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

  // Switch to a different namespace — gets or creates API key for it
  ipcMain.handle("papr:switch-namespace", async (_event, namespaceId: string, namespaceName: string) => {
    try {
      const profile = settingsStorage.getPaprProfile();
      if (!profile?.sessionToken || !profile?.organizationId || !profile?.userId) {
        return { success: false, error: "Not logged in or missing org info" };
      }

      // Check for existing API key in this namespace
      const keyData = await parseGraphQLWithRefresh(profile.sessionToken, GET_NAMESPACE_API_KEYS, {
        namespaceId,
      }, customKeysStorage, settingsStorage);

      let apiKey = keyData.aPIKeys?.edges?.[0]?.node?.key;

      // If no key exists, create one
      if (!apiKey) {
        console.log(`[PaprLogin] No API key for namespace ${namespaceId}, creating one...`);
        apiKey = await createApiKey(
          profile.sessionToken,
          profile.userId,
          profile.organizationId,
          namespaceId,
          "",
        );
      }

      // Update stored PAPR_API_KEY
      await customKeysStorage.addKey({
        name: "PAPR_API_KEY",
        value: apiKey,
      });

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
        `Auth0 error: ${error} - ${url.searchParams.get("error_description") || ""}`,
      );
    }

    if (!code) throw new Error("No authorization code received");
    if (!state || state !== loginState.pendingState) {
      throw new Error("Invalid state parameter — possible CSRF attack");
    }
    if (!loginState.codeVerifier) {
      throw new Error("No code verifier found — login flow may have expired");
    }

    // Exchange code for tokens
    console.log("[PaprLogin] Exchanging authorization code for tokens...");
    const tokens = await exchangeCodeForTokens(code, loginState.codeVerifier);

    // Clear login state
    loginState.pendingState = undefined;
    loginState.codeVerifier = undefined;

    // Decode ID token to extract Parse session token and user info
    if (!tokens.id_token) {
      throw new Error("No ID token received from Auth0");
    }

    const claims = decodeIdToken(tokens.id_token);
    const parseSessionToken = claims["https://papr.scope.com/sessionToken"];
    const objectId = claims["https://papr.scope.com/objectId"];
    const displayName =
      claims["https://papr.scope.com/displayName"] || claims.nickname || claims.name;
    const email = claims.email;

    if (!parseSessionToken || !objectId) {
      throw new Error(
        "Missing Parse session token or objectId in Auth0 claims. " +
          "Auth0 Actions may not have run correctly.",
      );
    }

    console.log(`[PaprLogin] Authenticated user: ${email} (${objectId})`);

    // Get user's workspace ID
    let workspaceId: string | undefined;
    try {
      const userData = await parseGraphQL(parseSessionToken, GET_USER_WORKSPACE, {
        userId: objectId,
      });
      workspaceId = userData.user?.isSelectedWorkspaceFollower?.workspace?.objectId;
    } catch (e) {
      console.warn("[PaprLogin] Could not fetch workspace ID:", e);
    }

    // Provision org/namespace/API key or retrieve existing one
    const provision = await provisionOrGetApiKey(
      parseSessionToken,
      objectId,
      email || "user",
      workspaceId,
    );

    // Store the API key as PAPR_API_KEY (same key the rest of the app expects)
    await customKeysStorage.addKey({
      name: "PAPR_API_KEY",
      value: provision.apiKey,
    });

    // Also store the session token for later namespace queries
    await customKeysStorage.addKey({
      name: "PAPR_SESSION_TOKEN",
      value: parseSessionToken,
    });

      // Store refresh token for automatic session renewal
      if (tokens.refresh_token) {
        await customKeysStorage.addKey({
          name: "PAPR_REFRESH_TOKEN",
          value: tokens.refresh_token,
        });
      }

    // Save user profile with org/namespace info
    settingsStorage.setPaprProfile({
      userId: objectId,
      email: email || "",
      displayName: displayName || "",
      authenticatedAt: new Date().toISOString(),
      sessionToken: parseSessionToken,
      organizationId: provision.organizationId,
      activeNamespaceId: provision.namespaceId,
      activeNamespaceName: provision.namespaceName,
    });

    console.log("[PaprLogin] Login complete. API key stored as PAPR_API_KEY.");

    // Notify renderer
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("papr:login-success", {
        email: email || "",
        name: displayName || "",
      });
    }
  } catch (err) {
    loginState.pendingState = undefined;
    loginState.codeVerifier = undefined;
    console.error("[PaprLogin] Callback failed:", err);

    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("papr:login-error", {
        error: err instanceof Error ? err.message : "Login failed",
      });
    }
  }
}

/**
 * Cleanup function called on app shutdown.
 */
export function cleanupPaprLogin(): void {
  loginState.pendingState = undefined;
  loginState.codeVerifier = undefined;
  console.log("[PaprLogin] Cleaned up login state.");
}
