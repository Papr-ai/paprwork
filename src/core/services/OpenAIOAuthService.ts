/**
 * OpenAIOAuthService - OAuth authentication for OpenAI ChatGPT subscriptions
 * Implements PKCE (Proof Key for Code Exchange) OAuth flow
 */

import crypto from "crypto";
import type { OAuthTokenInput } from "../storage/OAuthTokenStorage.js";

export interface PKCEChallenge {
  verifier: string;
  challenge: string;
  state: string;
}

export interface OAuthConfig {
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string;
}

/** JWT claim path for ChatGPT account ID (per OpenAI / pi-ai) */
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const decoded = Buffer.from(payload, "base64url").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract ChatGPT account ID from access token JWT (primary, per pi-ai) */
function extractAccountIdFromAccessToken(
  accessToken: string,
): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  const auth = payload[JWT_CLAIM_PATH] as
    | { chatgpt_account_id?: string }
    | undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0
    ? accountId
    : undefined;
}

/** Fallback: extract sub from id_token if access token doesn't have chatgpt_account_id */
function extractAccountIdFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  const payload = decodeJwtPayload(idToken);
  const sub = payload?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : undefined;
}

export class OpenAIOAuthService {
  private config: OAuthConfig = {
    // From @mariozechner/pi-ai openai-codex.js - public client for ChatGPT/Codex OAuth
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizationUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    // Must match pi-ai / OpenAI registration - localhost (not 127.0.0.1)
    redirectUri: "http://localhost:1455/auth/callback",
    scopes: "openid profile email offline_access",
  };

  /**
   * Generate PKCE challenge and verifier
   */
  generatePKCE(): PKCEChallenge {
    // Generate code verifier (43-128 characters, base64url)
    const verifier = crypto.randomBytes(32).toString("base64url").slice(0, 128);

    // Generate code challenge (SHA256 hash of verifier, base64url)
    const challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");

    // Generate random state for CSRF protection
    const state = crypto.randomBytes(16).toString("base64url");

    return {
      verifier,
      challenge,
      state,
    };
  }

  /**
   * Start OAuth flow - returns authorization URL
   * Extra params (id_token_add_organizations, codex_cli_simplified_flow, originator) per pi-ai
   */
  startOAuthFlow(): { url: string; pkce: PKCEChallenge } {
    const pkce = this.generatePKCE();

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: pkce.state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "paprwork",
    });

    const url = `${this.config.authorizationUrl}?${params.toString()}`;

    return { url, pkce };
  }

  /**
   * Exchange authorization code for tokens
   */
  async handleCallback(
    code: string,
    verifier: string,
    state: string,
    expectedState: string,
  ): Promise<OAuthTokenInput> {
    // Verify state matches (CSRF protection)
    if (state !== expectedState) {
      throw new Error("State mismatch - possible CSRF attack");
    }

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: verifier,
    });

    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      id_token?: string;
    };

    // Extract account ID from access token JWT (per pi-ai: https://api.openai.com/auth → chatgpt_account_id)
    const accountId =
      extractAccountIdFromAccessToken(data.access_token) ??
      extractAccountIdFromIdToken(data.id_token);

    return {
      provider: "openai",
      accountId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(refreshToken: string): Promise<OAuthTokenInput> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
    });

    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    return {
      provider: "openai",
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // Use new refresh token if provided
      expiresIn: data.expires_in,
    };
  }

  /**
   * Set custom OAuth configuration
   */
  setConfig(config: Partial<OAuthConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): OAuthConfig {
    return { ...this.config };
  }
}
