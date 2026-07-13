/**
 * Shared Auth0 PKCE helpers for Papr login (desktop + Cloud App Host).
 */

import * as crypto from "crypto";

export type PaprAuthMode = "login" | "signup";

export interface PaprAuth0Config {
  domain: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

const DEFAULT_SCOPE = "openid profile email offline_access";

function normalizeAuth0Domain(domain: string): string {
  return domain.replace(/^https?:\/\//, "");
}

export function getDesktopAuth0Config(): PaprAuth0Config {
  return {
    domain: normalizeAuth0Domain(process.env.AUTH0_DOMAIN || "papr.auth0.com"),
    clientId: process.env.AUTH0_CLIENT_ID || "asVGkVRkRAxYvtQadqivntIRjB4D1Iur",
    redirectUri: "papr://auth/callback",
    scope: DEFAULT_SCOPE,
  };
}

export function getCloudAppHostAuth0Config(publicBaseUrl: string): PaprAuth0Config {
  const configuredRedirect = process.env.PAPR_CLOUD_APP_AUTH_REDIRECT_URI?.trim();
  const base = publicBaseUrl.replace(/\/$/, "");
  return {
    domain: normalizeAuth0Domain(process.env.AUTH0_DOMAIN || "papr.auth0.com"),
    clientId: process.env.AUTH0_CLIENT_ID || "asVGkVRkRAxYvtQadqivntIRjB4D1Iur",
    redirectUri: configuredRedirect || `${base}/auth/callback`,
    scope: DEFAULT_SCOPE,
  };
}

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function generateAuthState(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function buildAuth0AuthorizeUrl(
  config: PaprAuth0Config,
  params: {
    state: string;
    codeChallenge: string;
    mode?: PaprAuthMode;
  },
): URL {
  const authUrl = new URL(`https://${config.domain}/authorize`);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", config.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", params.codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("scope", config.scope);
  authUrl.searchParams.set("state", params.state);
  authUrl.searchParams.set("audience", `https://${config.domain}/userinfo`);

  if (params.mode === "signup") {
    authUrl.searchParams.set("screen_hint", "signup");
  } else if (params.mode === "login") {
    authUrl.searchParams.set("screen_hint", "login");
  }

  return authUrl;
}

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

export interface Auth0TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  token_type: string;
}

export async function exchangeCodeForTokens(
  config: PaprAuth0Config,
  code: string,
  codeVerifier: string,
): Promise<Auth0TokenResponse> {
  const response = await fetch(`https://${config.domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: config.redirectUri,
    }),
  });

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(
      `Token exchange failed: ${response.status} ${errorData.error_description || errorData.error || response.statusText}`,
    );
  }

  return response.json() as Promise<Auth0TokenResponse>;
}

export function decodeIdToken(idToken: string): Record<string, unknown> {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload) as Record<string, unknown>;
}

export function extractParseSessionFromIdToken(claims: Record<string, unknown>): {
  sessionToken: string;
  objectId: string;
  email: string;
  displayName: string;
} {
  const sessionToken = claims["https://papr.scope.com/sessionToken"];
  const objectId = claims["https://papr.scope.com/objectId"];
  if (typeof sessionToken !== "string" || typeof objectId !== "string") {
    throw new Error(
      "Your account setup didn't finish. If you just signed up, wait a moment and try Sign in again.",
    );
  }

  const displayNameClaim = claims["https://papr.scope.com/displayName"];
  const nickname = claims.nickname;
  const name = claims.name;
  const email = claims.email;

  const displayName =
    (typeof displayNameClaim === "string" && displayNameClaim) ||
    (typeof nickname === "string" && nickname) ||
    (typeof name === "string" && name) ||
    "";

  return {
    sessionToken,
    objectId,
    email: typeof email === "string" ? email : "",
    displayName,
  };
}
