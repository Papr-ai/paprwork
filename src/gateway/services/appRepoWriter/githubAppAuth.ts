/**
 * GitHub App installation token for app-repo-writer pushes.
 */

import { createSign } from "node:crypto";

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

let cached: CachedToken | null = null;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

async function fetchInstallationToken(): Promise<string> {
  const appId = requireEnv("GITHUB_APP_ID");
  const privateKey = requireEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  const installId = requireEnv("GITHUB_APP_INSTALL_ID");

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  };
  const header = { alg: "RS256", typ: "JWT" };
  const encode = (obj: object): string =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey, "base64url");
  const jwt = `${unsigned}.${signature}`;

  const resp = await fetch(
    `https://api.github.com/app/installations/${installId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub installation token failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const body = (await resp.json()) as { token?: string; expires_at?: string };
  if (!body.token) {
    throw new Error("GitHub installation token response missing token");
  }
  const expiresAtMs = body.expires_at
    ? Date.parse(body.expires_at)
    : Date.now() + 55 * 60 * 1000;
  cached = { token: body.token, expiresAtMs };
  return body.token;
}

export async function getGithubInstallationToken(): Promise<string> {
  if (cached && cached.expiresAtMs > Date.now() + 60_000) {
    return cached.token;
  }
  return fetchInstallationToken();
}

export function cloneUrlWithToken(cloneUrl: string, token: string): string {
  const normalized = cloneUrl.replace(/^https:\/\//, "");
  return `https://x-access-token:${token}@${normalized}`;
}

/** Test-only — clear cached token. */
export function resetGithubTokenCacheForTests(): void {
  cached = null;
}
