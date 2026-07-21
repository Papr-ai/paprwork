/**
 * Shared env loading for manual / E2E test scripts.
 * Never hardcode API keys — require PAPR_API_KEY from .env.local or the shell.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Load `.env.local` into process.env (does not override existing vars). */
export function loadEnvLocal(cwd = process.cwd()) {
  try {
    const raw = readFileSync(join(cwd, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

/** @param {string} name */
export function requireEnv(name) {
  loadEnvLocal();
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`❌ ${name} required`);
    console.error(`   Set in .env.local or: export ${name}="..."`);
    process.exit(1);
  }
  return value;
}

export function requirePaprApiKey() {
  return requireEnv("PAPR_API_KEY");
}
