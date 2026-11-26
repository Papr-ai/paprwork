/**
 * The provider credential a script (job, app backend action, bash) should get
 * in OPENAI_API_KEY / ANTHROPIC_API_KEY.
 *
 * Those env slots used to be filled straight from the stored Settings key. That
 * copy is only rewritten when an OAuth token refreshes, and the Settings
 * "API key" form writes into the same slot — so after a user saved an API key
 * and switched back to OAuth, chat ran on the subscription while every script
 * kept sending the old API key (and hit that key's spend cap).
 *
 * Chat resolves through getProviderAuth, which honours the OAuth / API key
 * choice (main withholds the OAuth token when the user picked API key). Scripts
 * now ask the same question, so both always run on the same credential.
 */
import { getProviderAuth } from "./keyResolver.js";

const PROVIDER_BY_KEY: Record<string, "openai" | "anthropic"> = {
  OPENAI_API_KEY: "openai",
  ANTHROPIC_API_KEY: "anthropic",
};

/** Key names whose script value follows the chat's provider auth. */
export function isProviderAuthKeyName(keyName: string): boolean {
  return keyName in PROVIDER_BY_KEY;
}

/**
 * The live OAuth token for this key's provider when the user is on OAuth,
 * otherwise undefined (callers keep the stored value: the user chose API key,
 * or there is no live sign-in).
 */
export async function liveOAuthTokenForScriptKey(
  keyName: string,
): Promise<string | undefined> {
  const provider = PROVIDER_BY_KEY[keyName];
  if (!provider) return undefined;
  // The cloud gateway resolves provider auth from the vault value itself.
  if (process.env.GATEWAY_MODE === "cloud_agent") return undefined;
  try {
    const auth = await getProviderAuth(provider);
    return auth?.type === "oauth" ? auth.token : undefined;
  } catch (error) {
    console.warn(
      `[ScriptProviderCredential] Could not resolve ${provider} auth; using the stored key:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

/** Replace provider slots in an env map with the live OAuth token when on OAuth. */
export async function applyLiveProviderAuth(
  env: Record<string, string>,
): Promise<string[]> {
  const injected: string[] = [];
  for (const keyName of Object.keys(env)) {
    if (!isProviderAuthKeyName(keyName)) continue;
    const token = await liveOAuthTokenForScriptKey(keyName);
    if (token && token !== env[keyName]) {
      env[keyName] = token;
      injected.push(token);
    }
  }
  return injected;
}
