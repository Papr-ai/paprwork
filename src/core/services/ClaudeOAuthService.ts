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
    // Official Claude Code client ID (public client, supports loopback redirects)
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizationUrl: "https://claude.ai/oauth/authorize",
    // The platform API, not the consumer web app. `claude.ai/api/oauth/token`
    // sits behind Cloudflare's managed bot check, which answers a non-browser
    // POST with a 403 and an HTML challenge page — so every background refresh
    // failed and the connection expired with no way to renew itself. This is
    // the endpoint pi-ai uses on the streaming path, where refresh works.
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    // Claude Code uses http://localhost:{PORT}/callback (not 127.0.0.1, not /auth/callback)
    redirectUri: "http://localhost:1456/callback",
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
   * Standard PKCE flow matching Claude Code CLI's OAuth parameters
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
   * POST a grant to the token endpoint.
   *
   * The body is JSON, not form-urlencoded. RFC 6749 §4.1.3 does specify
   * form encoding, but this endpoint expects JSON and pi-ai — whose refresh
   * works today — sends JSON. Following the spec over the server cost us every
   * token renewal, so match the server.
   */
  private async postTokenGrant(
    grant: Record<string, string>,
    label: string,
  ): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  }> {
    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(grant),
      signal: AbortSignal.timeout(30_000),
    });

    const body = await response.text();

    if (!response.ok) {
      // Truncated: a bot-challenge or gateway error page runs to tens of
      // kilobytes of HTML, and dumping it into the log buries the one line
      // that says what went wrong.
      throw new Error(
        `${label} failed: ${response.status} - ${body.slice(0, 400)}`,
      );
    }

    try {
      return JSON.parse(body) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };
    } catch {
      throw new Error(
        `${label} returned a non-JSON response: ${body.slice(0, 400)}`,
      );
    }
  }

  /**
   * Exchange authorization code for tokens
   * Note: Claude returns code and state as separate query parameters
   */
  async handleCallback(
    code: string,
    verifier: string,
    state: string,
    expectedState: string,
  ): Promise<OAuthTokenInput> {
    if (state !== expectedState) {
      throw new Error("OAuth state mismatch - possible CSRF attack");
    }
    const data = await this.postTokenGrant(
      {
        grant_type: "authorization_code",
        client_id: this.config.clientId,
        code,
        // Sent alongside the code, matching pi-ai's working exchange.
        state,
        redirect_uri: this.config.redirectUri,
        code_verifier: verifier,
      },
      "Token exchange",
    );

    if (!data.refresh_token) {
      // Fail loudly instead of storing a connection that can never renew
      // itself — that silent gap is what produced 403s a day after connecting.
      throw new Error(
        "Token exchange succeeded but returned no refresh token; cannot establish a renewable connection",
      );
    }

    return {
      provider: "anthropic",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(refreshToken: string): Promise<OAuthTokenInput> {
    const data = await this.postTokenGrant(
      {
        grant_type: "refresh_token",
        client_id: this.config.clientId,
        refresh_token: refreshToken,
      },
      "Token refresh",
    );

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
