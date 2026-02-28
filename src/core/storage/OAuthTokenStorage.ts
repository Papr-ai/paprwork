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

/**
 * Encrypted token data stored in memory (not decrypted until needed)
 */
interface EncryptedOAuthToken {
  id: string;
  provider: "openai" | "anthropic";
  accountId?: string;
  encryptedAccessToken: string; // Base64 encrypted
  encryptedRefreshToken: string; // Base64 encrypted
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export class OAuthTokenStorage {
  private dataDir: string;
  private tokensFile: string;
  private tokens: Map<string, EncryptedOAuthToken> = new Map(); // Store encrypted!

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
        "[OAuthTokens] Encryption not available, using base64 encoding",
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
   * Encrypt token data before storage (returns encrypted structure)
   */
  private encryptToken(token: OAuthToken): EncryptedOAuthToken {
    return {
      id: token.id,
      provider: token.provider,
      accountId: token.accountId,
      encryptedAccessToken: this.encryptValue(token.accessToken),
      encryptedRefreshToken: this.encryptValue(token.refreshToken),
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
      updatedAt: token.updatedAt,
    };
  }

  /**
   * Decrypt token data on-demand (LAZY - only when actually needed)
   * This triggers keychain access!
   */
  private decryptToken(encryptedToken: EncryptedOAuthToken): OAuthToken {
    return {
      id: encryptedToken.id,
      provider: encryptedToken.provider,
      accountId: encryptedToken.accountId,
      accessToken: this.decryptValue(encryptedToken.encryptedAccessToken),
      refreshToken: this.decryptValue(encryptedToken.encryptedRefreshToken),
      expiresAt: encryptedToken.expiresAt,
      createdAt: encryptedToken.createdAt,
      updatedAt: encryptedToken.updatedAt,
    };
  }

  /**
   * Load tokens from file (LAZY - stores encrypted, no keychain access!)
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

        // Store encrypted tokens directly - NO DECRYPTION on load!
        this.tokens = new Map(
          Object.entries(data).map(([id, tokenData]) => [
            id,
            {
              id: tokenData.id as string,
              provider: tokenData.provider as "openai" | "anthropic",
              accountId: tokenData.accountId as string | undefined,
              encryptedAccessToken: tokenData.accessToken as string,
              encryptedRefreshToken: tokenData.refreshToken as string,
              expiresAt: tokenData.expiresAt as string,
              createdAt: tokenData.createdAt as string,
              updatedAt: tokenData.updatedAt as string,
            } as EncryptedOAuthToken,
          ]),
        );

        console.log(
          `[OAuthTokens] Loaded ${this.tokens.size} OAuth tokens (encrypted, not decrypted)`,
        );
      }
    } catch (error) {
      console.error("[OAuthTokens] Failed to load tokens:", error);
      this.tokens = new Map();
    }
  }

  /**
   * Save tokens to file (atomic write)
   * Tokens are already encrypted in memory, just convert format
   */
  private async saveTokens(): Promise<void> {
    try {
      const data = Object.fromEntries(
        Array.from(this.tokens.entries()).map(([id, encryptedToken]) => [
          id,
          {
            id: encryptedToken.id,
            provider: encryptedToken.provider,
            accountId: encryptedToken.accountId,
            accessToken: encryptedToken.encryptedAccessToken,
            refreshToken: encryptedToken.encryptedRefreshToken,
            expiresAt: encryptedToken.expiresAt,
            createdAt: encryptedToken.createdAt,
            updatedAt: encryptedToken.updatedAt,
          },
        ]),
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
   * Store a new OAuth token (encrypts and stores in memory)
   */
  async storeToken(input: OAuthTokenInput): Promise<OAuthToken> {
    const id = `oauth-${input.provider}-${Date.now()}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + input.expiresIn * 1000,
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
    const oldToken = this.getEncryptedTokenByProvider(input.provider);
    if (oldToken) {
      this.tokens.delete(oldToken.id);
    }

    // Encrypt and store
    const encryptedToken = this.encryptToken(token);
    this.tokens.set(id, encryptedToken);
    await this.saveTokens();

    console.log(`[OAuthTokens] Stored ${input.provider} OAuth token (encrypted)`);
    return token; // Return decrypted for immediate use
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
    },
  ): Promise<OAuthToken | null> {
    const encryptedToken = this.tokens.get(tokenId);
    if (!encryptedToken) return null;

    // Decrypt current token to get refresh token if not provided
    const currentToken = this.decryptToken(encryptedToken);
    
    const expiresAt = new Date(
      Date.now() + updates.expiresIn * 1000,
    ).toISOString();

    const updatedToken: OAuthToken = {
      ...currentToken,
      accessToken: updates.accessToken,
      refreshToken: updates.refreshToken || currentToken.refreshToken,
      expiresAt,
      updatedAt: new Date().toISOString(),
    };

    // Encrypt and store
    const newEncryptedToken = this.encryptToken(updatedToken);
    this.tokens.set(tokenId, newEncryptedToken);
    await this.saveTokens();

    console.log(`[OAuthTokens] Updated ${encryptedToken.provider} OAuth token`);
    return updatedToken;
  }

  /**
   * Get encrypted token by provider (internal helper, no decryption)
   */
  private getEncryptedTokenByProvider(
    provider: "openai" | "anthropic",
  ): EncryptedOAuthToken | undefined {
    return Array.from(this.tokens.values()).find(
      (token) => token.provider === provider,
    );
  }

  /**
   * Get token by provider (LAZY DECRYPT - triggers keychain!)
   */
  getTokenByProvider(provider: "openai" | "anthropic"): OAuthToken | undefined {
    const encryptedToken = this.getEncryptedTokenByProvider(provider);
    if (!encryptedToken) return undefined;

    console.log(`[OAuthTokens] Decrypting ${provider} token (keychain access)`);
    return this.decryptToken(encryptedToken);
  }

  /**
   * Get token by ID (LAZY DECRYPT - triggers keychain!)
   */
  getTokenById(tokenId: string): OAuthToken | undefined {
    const encryptedToken = this.tokens.get(tokenId);
    if (!encryptedToken) return undefined;

    console.log(
      `[OAuthTokens] Decrypting token ${tokenId} (keychain access)`,
    );
    return this.decryptToken(encryptedToken);
  }

  /**
   * Check if a token is expired or about to expire (works on encrypted token metadata)
   */
  isTokenExpired(
    token: OAuthToken | EncryptedOAuthToken,
    bufferMinutes: number = 5,
  ): boolean {
    const expiresAt = new Date(token.expiresAt).getTime();
    const now = Date.now();
    const buffer = bufferMinutes * 60 * 1000;
    return now >= expiresAt - buffer;
  }

  /**
   * Check if a token is expired by provider (no decryption needed!)
   */
  isTokenExpiredByProvider(
    provider: "openai" | "anthropic",
    bufferMinutes: number = 5,
  ): boolean {
    const encryptedToken = this.getEncryptedTokenByProvider(provider);
    if (!encryptedToken) return true;
    return this.isTokenExpired(encryptedToken, bufferMinutes);
  }

  /**
   * Delete a token by provider
   */
  async deleteTokenByProvider(
    provider: "openai" | "anthropic",
  ): Promise<boolean> {
    const encryptedToken = this.getEncryptedTokenByProvider(provider);
    if (!encryptedToken) return false;

    const existed = this.tokens.delete(encryptedToken.id);
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
   * List all tokens (without sensitive data, no decryption!)
   */
  listTokens(): Array<
    Omit<OAuthToken, "accessToken" | "refreshToken"> & {
      isExpired: boolean;
    }
  > {
    return Array.from(this.tokens.values()).map((encryptedToken) => ({
      id: encryptedToken.id,
      provider: encryptedToken.provider,
      accountId: encryptedToken.accountId,
      expiresAt: encryptedToken.expiresAt,
      createdAt: encryptedToken.createdAt,
      updatedAt: encryptedToken.updatedAt,
      isExpired: this.isTokenExpired(encryptedToken, 0), // No buffer for listing
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
