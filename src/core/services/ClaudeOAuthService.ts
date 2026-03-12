/**
 * ClaudeOAuthService - OAuth authentication for Claude Pro/Max subscriptions
 * Implements PKCE (Proof Key for Code Exchange) OAuth flow
 * Based on OpenClaw's implementation
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

export class ClaudeOAuthService {
  private config: OAuthConfig = {
    // From OpenClaw research - official Claude Code client ID
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    // Use claude.ai for authorization (where the user actually authenticates)
    authorizationUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://claude.ai/api/oauth/token",
    redirectUri: "http://127.0.0.1:1456/auth/callback",
    scopes: "user:profile user:inference",
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
   * Note: Claude expects code=true parameter in addition to response_type=code
   */
  startOAuthFlow(): { url: string; pkce: PKCEChallenge } {
    const pkce = this.generatePKCE();

    const params = new URLSearchParams({
      code: "true", // Claude-specific: indicates authorization code flow
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
   * Note: Claude returns code and state as separate query parameters
   * IMPORTANT: Must use application/x-www-form-urlencoded per OAuth 2.0 RFC 6749 Section 4.1.3
   */
  async handleCallback(
    code: string,
    verifier: string,
    _state: string, // State validation handled by IPC layer
  ): Promise<OAuthTokenInput> {
    // OAuth 2.0 RFC 6749 requires form-urlencoded, not JSON!
    const params = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
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
    };

    return {
      provider: "anthropic",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Refresh access token using refresh token
   * IMPORTANT: Must use application/x-www-form-urlencoded per OAuth 2.0 RFC 6749
   */
  async refreshToken(refreshToken: string): Promise<OAuthTokenInput> {
    // OAuth 2.0 RFC 6749 requires form-urlencoded, not JSON!
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
      provider: "anthropic",
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // Use new refresh token if provided
      expiresIn: data.expires_in,
    };
  }

  /**
   * Set custom OAuth configuration (for testing/development)
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
