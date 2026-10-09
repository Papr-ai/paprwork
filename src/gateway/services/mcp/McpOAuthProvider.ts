/**
 * OAuthClientProvider for one remote MCP server, persisted in the keychain.
 *
 * The MCP SDK drives the whole OAuth dance (protected-resource discovery,
 * dynamic client registration, PKCE, code exchange, refresh). This class only
 * answers "what do we have stored" and "save this", plus opening the browser.
 *
 * Everything for one server lives in a single encrypted custom key
 * (`MCP_LINEAR_OAUTH` …) so it rides the existing keychain + vault sync and
 * never touches disk in clear.
 *
 * Non-interactive mode: background reconnects and tool calls must never pop a
 * browser. If a refresh fails and the SDK asks to redirect, we record that the
 * server needs re-auth and throw instead.
 */

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface McpStoredCredential {
  /** Dynamic-registration result (or pre-registered client id). */
  client?: OAuthClientInformationMixed;
  /** Redirect URI the client was registered with — a different port needs a new registration. */
  clientRedirectUri?: string;
  tokens?: OAuthTokens;
  /** ISO time tokens were saved; expires_in is relative to this. */
  tokensSavedAt?: string;
  /** PKCE verifier for an in-flight authorization (cleared after exchange). */
  codeVerifier?: string;
  /** Signed in through the Papr server: only the server refreshes; this Mac claims fresh tokens. */
  serverRefresh?: boolean;
}

/** True when a server-managed access token is missing or expires within `skewMs`. */
export function serverTokenStale(c: McpStoredCredential | null | undefined, skewMs = 60_000): boolean {
  if (!c?.tokens?.access_token) return true;
  const ttl = Number(c.tokens.expires_in);
  if (!c.tokensSavedAt || !Number.isFinite(ttl)) return false;
  return Date.parse(c.tokensSavedAt) + ttl * 1000 - Date.now() < skewMs;
}

/** Where provider state is persisted. Production: CustomKeysService; tests: in-memory. */
export interface McpCredentialStore {
  load(serverId: string): Promise<McpStoredCredential | null>;
  save(serverId: string, value: McpStoredCredential): Promise<void>;
  remove(serverId: string): Promise<void>;
}

/** Never listened on; only used so the SDK takes the authorization-code path. */
const NON_INTERACTIVE_REDIRECT_PLACEHOLDER = "http://127.0.0.1:18793/mcp/callback";

export class McpReauthRequiredError extends Error {
  constructor(public readonly serverId: string) {
    super(`MCP server "${serverId}" needs to be reconnected (sign-in expired). Use connect_mcp action="connect".`);
    this.name = "McpReauthRequiredError";
  }
}

export interface McpOAuthProviderOptions {
  serverId: string;
  store: McpCredentialStore;
  /** Loopback redirect, e.g. http://127.0.0.1:18793/mcp/callback. Required when interactive. */
  redirectUri?: string;
  /** When true, redirectToAuthorization opens the browser; otherwise it throws. */
  interactive: boolean;
  openBrowser: (url: string) => Promise<void> | void;
  /** Pre-registered public client id for servers without DCR. */
  staticClientId?: string;
  /** CSRF state appended to the authorization URL and checked on callback. */
  state?: string;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private cache: McpStoredCredential | null = null;
  private loaded = false;
  /** Set when the SDK asked us to open the browser. */
  authorizationUrl: URL | null = null;

  constructor(private readonly opts: McpOAuthProviderOptions) {}

  get redirectUrl(): string {
    // Always defined: an undefined redirectUrl tells the SDK this is a
    // machine-to-machine flow (client_credentials), so a dead refresh would
    // fail with "prepareTokenRequest() required" instead of reaching
    // redirectToAuthorization — where non-interactive mode reports reauth.
    return this.opts.redirectUri ?? NON_INTERACTIVE_REDIRECT_PLACEHOLDER;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Papr Work",
      client_uri: "https://papr.ai",
      // Shown on consent screens (RFC 7591 logo_uri). Must be a square, full-bleed
      // PNG: the old SVG mark was 105x124 with padding, so it rendered shrunken.
      // Baked into the dynamic registration: existing clients keep the old logo
      // until they reconnect.
      logo_uri: "https://raw.githubusercontent.com/Papr-ai/paprwork/master/build/oauth-logo.png",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.opts.state ?? "";
  }

  private async read(): Promise<McpStoredCredential> {
    if (!this.loaded) {
      this.cache = (await this.opts.store.load(this.opts.serverId)) ?? {};
      this.loaded = true;
    }
    return this.cache ?? {};
  }

  private async write(patch: Partial<McpStoredCredential>): Promise<void> {
    const next = { ...(await this.read()), ...patch };
    this.cache = next;
    await this.opts.store.save(this.opts.serverId, next);
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.opts.staticClientId) return { client_id: this.opts.staticClientId };
    const stored = await this.read();
    if (!stored.client) return undefined;
    // Registered against a different loopback port: during an interactive
    // sign-in the server would reject our redirect, so register again.
    // Non-interactive refresh never sends a redirect, so the old client is fine.
    if (
      this.opts.interactive &&
      this.opts.redirectUri &&
      stored.clientRedirectUri &&
      stored.clientRedirectUri !== this.opts.redirectUri
    ) {
      return undefined;
    }
    return stored.client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    await this.write({ client, clientRedirectUri: this.opts.redirectUri });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.read()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.write({ tokens, tokensSavedAt: new Date().toISOString(), codeVerifier: undefined });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.opts.interactive) {
      throw new McpReauthRequiredError(this.opts.serverId);
    }
    this.authorizationUrl = authorizationUrl;
    await this.opts.openBrowser(authorizationUrl.toString());
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.write({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const v = (await this.read()).codeVerifier;
    if (!v) throw new Error(`No PKCE verifier stored for MCP server "${this.opts.serverId}"`);
    return v;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "discovery") return;
    if (scope === "all") {
      this.cache = {};
      this.loaded = true;
      await this.opts.store.remove(this.opts.serverId);
      return;
    }
    if (scope === "client") await this.write({ client: undefined, clientRedirectUri: undefined });
    if (scope === "tokens") await this.write({ tokens: undefined, tokensSavedAt: undefined });
    if (scope === "verifier") await this.write({ codeVerifier: undefined });
  }

  async hasTokens(): Promise<boolean> {
    return Boolean((await this.read()).tokens?.access_token);
  }
}
