#!/usr/bin/env node
/**
 * Verifies ClaudeCLIManager can download and run the CLI without npm.
 * Requires Electron (uses app.getPath('userData')).
 *
 * Usage: npm run test:claude-cli-on-demand
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const { app } = electron;

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function main() {
  await app.whenReady();

  const { getClaudeCLIManager } = await import(
    path.join(repoRoot, "dist/electron/electron/services/ClaudeCLIManager.js")
  );

  const manager = getClaudeCLIManager();
  console.log("[test-claude-cli-on-demand] Ensuring CLI (HTTPS tarball, no npm)...");

  const cliPath = await manager.ensureCLI();
  console.log("[test-claude-cli-on-demand] CLI path:", cliPath);

  const version = await manager.getVersion();
  if (!version) {
    throw new Error("CLI --version returned empty output");
  }
  console.log("[test-claude-cli-on-demand] Version:", version);

  const { ClaudeSetupTokenService } = await import(
    path.join(repoRoot, "dist/electron/core/services/ClaudeSetupTokenService.js")
  );
  const service = new ClaudeSetupTokenService();
  service.setClaudeCliProvider(manager);

  const check = await service.getClaudeCliCheck();
  if (!check.installed) {
    throw new Error("getClaudeCliCheck reported not installed after ensureCLI");
  }
  console.log("[test-claude-cli-on-demand] Check:", check);

  const shellCmd = await service.getSetupTokenShellCommand();
  console.log("[test-claude-cli-on-demand] setup-token command:", shellCmd);

  if (shellCmd.includes("npm")) {
    throw new Error("setup-token command must not reference npm");
  }

  console.log("[test-claude-cli-on-demand] OK");
  app.quit();
}

main().catch((err) => {
  console.error("[test-claude-cli-on-demand] FAILED:", err);
  app.quit();
  process.exit(1);
});
