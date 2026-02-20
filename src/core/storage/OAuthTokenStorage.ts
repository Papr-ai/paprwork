/**
 * OAuthTokenStorage - Secure storage for OAuth tokens
 * Stores tokens for OpenAI and Claude subscriptions
 * Uses Electron safeStorage (macOS Keychain / Windows DPAPI)
 */

import fs from "fs/promises";
import path from "path";
import electron from "electron";
const { app, safeStorage } = electron;

export interface OAuthToken {
  id: string;
  provider: "openai" | "anthropic";
  accountId?: string; // Optional, may not be available for all providers
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO timestamp
  createdAt: string;
  updatedAt: string;
}

export interface OAuthTokenInput {
  provider: "openai" | "anthropic";
  accountId?: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // Seconds until expiry
}

export class OAuthTokenStorage {
  private dataDir: string;
  private tokensFile: string;
  private tokens: Map<string, OAuthToken> = new Map();

  constructor() {
    this.dataDir = path.join(app.getPath("userData"), "data");
    this.tokensFile = path.join(this.dataDir, "oauth-tokens.json");
  }

  /**
   * Initialize storage - create directory and load tokens
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.loadTokens();
  }

  /**
   * Encrypt a value using Electron's safeStorage (macOS Keychain)
   */
  private encryptValue(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn(
        "[OAuthTokens] Encryption not available, using base64 encoding"
      );
      return Buffer.from(value).toString("base64");
    }
    return safeStorage.encryptString(value).toString("base64");
  }

  /**
   * Decrypt a value using Electron's safeStorage
   */
  private decryptValue(encryptedValue: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      return Buffer.from(encryptedValue, "base64").toString("utf-8");
    }
    const buffer = Buffer.from(encryptedValue, "base64");
    return safeStorage.decryptString(buffer);
  }

  /**
   * Encrypt token data before storage
   */
  private encryptToken(token: OAuthToken): Record<string, unknown> {
    return {
      id: token.id,
      provider: token.provider,
      accountId: token.accountId,
      accessToken: this.encryptValue(token.accessToken),
      refreshToken: this.encryptValue(token.refreshToken),
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
      updatedAt: token.updatedAt,
    };
  }

  /**
   * Decrypt token data after loading
   */
  private decryptToken(data: Record<string, unknown>): OAuthToken {
    return {
      id: data.id as string,
      provider: data.provider as "openai" | "anthropic",
      accountId: data.accountId as string | undefined,
      accessToken: this.decryptValue(data.accessToken as string),
      refreshToken: this.decryptValue(data.refreshToken as string),
      expiresAt: data.expiresAt as string,
      createdAt: data.createdAt as string,
      updatedAt: data.updatedAt as string,
    };
  }

  /**
   * Load tokens from file
   */
  private async loadTokens(): Promise<void> {
    try {
      const exists = await fs
        .access(this.tokensFile)
        .then(() => true)
        .catch(() => false);

      if (exists) {
        const fileContent = await fs.readFile(this.tokensFile, "utf-8");
        const data = JSON.parse(fileContent) as Record<
          string,
          Record<string, unknown>
        >;

        this.tokens = new Map(
          Object.entries(data).map(([id, tokenData]) => [
            id,
            this.decryptToken(tokenData),
          ])
        );

        console.log(
          `[OAuthTokens] Loaded ${this.tokens.size} OAuth tokens from storage`
        );
      }
    } catch (error) {
      console.error("[OAuthTokens] Failed to load tokens:", error);
      this.tokens = new Map();
    }
  }

  /**
   * Save tokens to file (atomic write)
   */
  private async saveTokens(): Promise<void> {
    try {
      const data = Object.fromEntries(
        Array.from(this.tokens.entries()).map(([id, token]) => [
          id,
          this.encryptToken(token),
        ])
      );

      const tempFile = `${this.tokensFile}.tmp`;

      // Write to temp file first
      await fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf-8");

      // Atomic rename
      await fs.rename(tempFile, this.tokensFile);
    } catch (error) {
      console.error("[OAuthTokens] Failed to save tokens:", error);
      throw error;
    }
  }

  /**
   * Store a new OAuth token
   */
  async storeToken(input: OAuthTokenInput): Promise<OAuthToken> {
    const id = `oauth-${input.provider}-${Date.now()}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + input.expiresIn * 1000
    ).toISOString();

    const token: OAuthToken = {
      id,
      provider: input.provider,
      accountId: input.accountId,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    };

    // Remove old token for same provider
    const oldToken = this.getTokenByProvider(input.provider);
    if (oldToken) {
      this.tokens.delete(oldToken.id);
    }

    this.tokens.set(id, token);
    await this.saveTokens();

    console.log(`[OAuthTokens] Stored ${input.provider} OAuth token`);
    return token;
  }

  /**
   * Update an existing OAuth token (for refresh)
   */
  async updateToken(
    tokenId: string,
    updates: {
      accessToken: string;
      refreshToken?: string;
      expiresIn: number;
    }
  ): Promise<OAuthToken | null> {
    const token = this.tokens.get(tokenId);
    if (!token) return null;

    const expiresAt = new Date(
      Date.now() + updates.expiresIn * 1000
    ).toISOString();

    const updatedToken: OAuthToken = {
      ...token,
      accessToken: updates.accessToken,
      refreshToken: updates.refreshToken || token.refreshToken,
      expiresAt,
      updatedAt: new Date().toISOString(),
    };

    this.tokens.set(tokenId, updatedToken);
    await this.saveTokens();

    console.log(`[OAuthTokens] Updated ${token.provider} OAuth token`);
    return updatedToken;
  }

  /**
   * Get token by provider
   */
  getTokenByProvider(
    provider: "openai" | "anthropic"
  ): OAuthToken | undefined {
    return Array.from(this.tokens.values()).find(
      (token) => token.provider === provider
    );
  }

  /**
   * Get token by ID
   */
  getTokenById(tokenId: string): OAuthToken | undefined {
    return this.tokens.get(tokenId);
  }

  /**
   * Check if a token is expired or about to expire
   */
  isTokenExpired(token: OAuthToken, bufferMinutes: number = 5): boolean {
    const expiresAt = new Date(token.expiresAt).getTime();
    const now = Date.now();
    const buffer = bufferMinutes * 60 * 1000;
    return now >= expiresAt - buffer;
  }

  /**
   * Delete a token by provider
   */
  async deleteTokenByProvider(
    provider: "openai" | "anthropic"
  ): Promise<boolean> {
    const token = this.getTokenByProvider(provider);
    if (!token) return false;

    const existed = this.tokens.delete(token.id);
    if (existed) {
      await this.saveTokens();
      console.log(`[OAuthTokens] Deleted ${provider} OAuth token`);
    }
    return existed;
  }

  /**
   * Delete a token by ID
   */
  async deleteTokenById(tokenId: string): Promise<boolean> {
    const existed = this.tokens.delete(tokenId);
    if (existed) {
      await this.saveTokens();
      console.log(`[OAuthTokens] Deleted OAuth token: ${tokenId}`);
    }
    return existed;
  }

  /**
   * List all tokens (without sensitive data)
   */
  listTokens(): Array<
    Omit<OAuthToken, "accessToken" | "refreshToken"> & {
      isExpired: boolean;
    }
  > {
    return Array.from(this.tokens.values()).map((token) => ({
      id: token.id,
      provider: token.provider,
      accountId: token.accountId,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
      updatedAt: token.updatedAt,
      isExpired: this.isTokenExpired(token, 0), // No buffer for listing
    }));
  }

  /**
   * Clear all tokens
   */
  async clearAllTokens(): Promise<void> {
    this.tokens.clear();
    await this.saveTokens();
    console.log("[OAuthTokens] Cleared all OAuth tokens");
  }
}
