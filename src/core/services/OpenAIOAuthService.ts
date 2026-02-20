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

export class OpenAIOAuthService {
  private config: OAuthConfig = {
    clientId: "", // TODO: Needs to be configured via OpenAI developer console
    authorizationUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    scopes: "openid profile email", // TODO: Verify correct scopes for ChatGPT subscription
  };

  /**
   * Generate PKCE challenge and verifier
   */
  generatePKCE(): PKCEChallenge {
    // Generate code verifier (43-128 characters, base64url)
    const verifier = crypto
      .randomBytes(32)
      .toString("base64url")
      .slice(0, 128);

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
   */
  startOAuthFlow(): { url: string; pkce: PKCEChallenge } {
    const pkce = this.generatePKCE();

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: pkce.state,
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
    expectedState: string
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

    // Parse ID token to get account ID if available
    let accountId: string | undefined;
    if (data.id_token) {
      try {
        const payload = JSON.parse(
          Buffer.from(data.id_token.split(".")[1], "base64").toString()
        );
        accountId = payload.sub;
      } catch (error) {
        console.warn("[OpenAIOAuth] Failed to parse ID token:", error);
      }
    }

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
