#!/usr/bin/env node
/**
 * Live probe: Claude subscription usage (Claude Code Keychain first, then Paprwork store).
 * Must run under Electron (encrypted oauth-tokens.json).
 *
 *   npm run test:claude-oauth-usage
 */

import electron from "electron";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { app } = electron;

async function importDist(modulePath) {
  const abs = join(process.cwd(), "dist", modulePath);
  return import(pathToFileURL(abs).href);
}

async function main() {
  app.setName("Papr Work");
  await app.whenReady();

  const { OAuthTokenStorage } = await importDist(
    "electron/core/storage/OAuthTokenStorage.js",
  );
  const { ClaudeSetupTokenService } = await importDist(
    "electron/core/services/ClaudeSetupTokenService.js",
  );
  const { fetchClaudeSubscriptionUsageFromCandidates } = await importDist(
    "electron/core/services/claudeOAuthUsage.js",
  );
  const {
    dedupeAccessTokens,
    readClaudeAuthStatusFromCli,
  } = await importDist("electron/core/services/claudeCodeUsageSource.js");
  const { claudeAccessTokenIsLive } = await importDist(
    "electron/core/services/claudeCliCredentials.js",
  );

  const authStatus = await readClaudeAuthStatusFromCli();
  console.log("[test] claude auth status:", authStatus ?? "(cli unavailable)");

  const candidates = [];
  const setup = new ClaudeSetupTokenService();
  const cliCreds = await setup.readCredentialsFromCLIStorage();
  if (cliCreds?.accessToken && claudeAccessTokenIsLive(cliCreds)) {
    candidates.push({
      accessToken: cliCreds.accessToken,
      source: "claude_code_keychain",
    });
    console.log("[test] Claude Code Keychain token: live");
  } else if (cliCreds?.accessToken) {
    console.log("[test] Claude Code Keychain token: expired or stale");
  } else {
    console.log("[test] No Claude Code Keychain credentials");
  }

  const storage = new OAuthTokenStorage();
  await storage.initialize();
  const token = storage.getTokenByProvider("anthropic");
  if (token?.accessToken) {
    candidates.push({
      accessToken: token.accessToken,
      source: "papr_stored",
    });
    console.log(
      `[test] Paprwork token expires ${token.expiresAt} (account ${token.accountId?.slice(0, 12) ?? "?"})`,
    );
  }

  const unique = dedupeAccessTokens(candidates);
  if (unique.length === 0) {
    console.error(
      "No Claude OAuth token — connect in Settings or run claude auth login.",
    );
    app.quit();
    return;
  }

  const result = await fetchClaudeSubscriptionUsageFromCandidates(unique, {
    orgUuidHint: authStatus?.orgId ?? undefined,
    subscriptionType: authStatus?.subscriptionType,
    orgName: authStatus?.orgName,
  });

  if (!result.success) {
    console.error("[test] FAILED:", result.error);
    if (result.attempts?.length) {
      console.error("[test] Attempts:", result.attempts.join("\n  "));
    }
    app.quit();
    return;
  }

  console.log("[test] OK via", result.data.source, result.data.credentialSource);
  console.log(JSON.stringify(result.data, null, 2));
  app.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
