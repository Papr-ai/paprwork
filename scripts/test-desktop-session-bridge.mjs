#!/usr/bin/env node
/**
 * Desktop session bridge smoke test.
 *
 * Usage:
 *   node scripts/test-desktop-session-bridge.mjs [--host URL] [--gateway URL]
 *   node scripts/test-desktop-session-bridge.mjs --host=https://apps.papr.ai
 *
 * With gateway running + Papr logged in, also tests seed-session → cookies.
 */

import { readFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const host = (
  args.find((a) => a.startsWith("--host="))?.split("=")[1] ?? "http://localhost:8787"
).replace(/\/$/, "");
const gateway = (
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  "http://localhost:18789"
).replace(/\/$/, "");
const sessionTokenArg = args.find((a) => a.startsWith("--session-token="))?.split("=")[1];
const namespaceId =
  args.find((a) => a.startsWith("--namespace="))?.split("=")[1] ?? "HyQU6FnQW3";
const slug =
  args.find((a) => a.startsWith("--slug="))?.split("=")[1] ?? "decision-provenance";

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
    passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function loadEnvLocal() {
  try {
    const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
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

function readSetCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

function parseCookieValue(setCookieHeader, name) {
  const pair = setCookieHeader.split(";")[0] ?? "";
  if (!pair.startsWith(`${name}=`)) return null;
  const raw = pair.slice(name.length + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function main() {
  loadEnvLocal();

  console.log(`\nDesktop session bridge — ${host}\n`);

  // Health
  try {
    const health = await fetch(`${host}/health`);
    check("host /health", health.ok, `HTTP ${health.status}`);
  } catch (err) {
    check("host /health", false, err instanceof Error ? err.message : String(err));
    console.log(`\nStart host: npm run start:cloud-app-host\n`);
    process.exit(1);
  }

  // Bridge rejects missing token
  const noToken = await fetch(
    `${host}/auth/desktop-bridge?returnTo=${encodeURIComponent(`/${namespaceId}/${slug}/`)}`,
    { redirect: "manual" },
  );
  check(
    "bridge rejects missing X-Session-Token",
    noToken.status === 401,
    `HTTP ${noToken.status}`,
  );

  // Bridge rejects invalid token
  const badToken = await fetch(
    `${host}/auth/desktop-bridge?returnTo=${encodeURIComponent(`/${namespaceId}/${slug}/`)}`,
    {
      redirect: "manual",
      headers: { "X-Session-Token": "invalid_session_token_for_test" },
    },
  );
  check(
    "bridge rejects invalid session",
    badToken.status === 401,
    `HTTP ${badToken.status}`,
  );

  // Bridge rejects bad returnTo
  const badReturn = await fetch(`${host}/auth/desktop-bridge?returnTo=/api/db/query`, {
    redirect: "manual",
    headers: { "X-SSession-Token": "x" },
  });
  check(
    "bridge rejects non-browsable returnTo",
    badReturn.status === 400 || badReturn.status === 401,
    `HTTP ${badReturn.status}`,
  );

  const sessionToken = sessionTokenArg ?? process.env.PAPR_SESSION_TOKEN;
  if (sessionToken?.trim()) {
    const bridge = await fetch(
      `${host}/auth/desktop-bridge?returnTo=${encodeURIComponent(`/${namespaceId}/${slug}/`)}`,
      {
        redirect: "manual",
        headers: { "X-Session-Token": sessionToken.trim() },
      },
    );
    const cookies = readSetCookies(bridge);
    const sessionCookie = cookies.find((c) => {
      const val = parseCookieValue(c, "papr_session");
      return val && val.length > 0;
    });
    check(
      "bridge mints papr_session cookie",
      bridge.status === 302 && Boolean(sessionCookie),
      `HTTP ${bridge.status}, cookies=${cookies.length}`,
    );
    check(
      "bridge redirect location",
      bridge.headers.get("location")?.includes(`/${namespaceId}/${slug}`) ?? false,
      bridge.headers.get("location") ?? "none",
    );
  } else {
    console.log(`  ${YELLOW}SKIP${RESET} bridge with real session — pass --session-token= or PAPR_SESSION_TOKEN`);
  }

  // Gateway seed-session (uses keychain via running Paprwork gateway)
  try {
    const gwHealth = await fetch(`${gateway}/health`);
    if (!gwHealth.ok) throw new Error(`gateway HTTP ${gwHealth.status}`);

    const seedResp = await fetch(`${gateway}/api/cloud-preview/seed-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespaceId, slug }),
    });
    const seedBody = await seedResp.json().catch(() => ({}));
    const contentType = seedResp.headers.get("content-type") ?? "";

    if (!contentType.includes("application/json")) {
      console.log(
        `  ${YELLOW}SKIP${RESET} gateway seed-session — restart Paprwork/gateway to load /api/cloud-preview/seed-session`,
      );
    } else if (seedResp.status === 401) {
      console.log(`  ${YELLOW}SKIP${RESET} gateway seed-session — not logged in to Papr`);
    } else if (seedResp.status === 503) {
      console.log(
        `  ${YELLOW}SKIP${RESET} gateway seed-session — bridge not on ${process.env.PAPR_CLOUD_APPS_HOST ?? "https://apps.papr.ai"} yet (deploy first)`,
      );
    } else {
      check(
        "gateway seed-session success",
        seedResp.ok && seedBody.success === true,
        seedBody.error ?? `HTTP ${seedResp.status}`,
      );
      if (seedBody.success && !seedBody.cached) {
        check(
          "seed returns papr_session cookie",
          Array.isArray(seedBody.cookies) &&
            seedBody.cookies.some((c) => c?.name === "papr_session" && c?.value),
          `cookies=${seedBody.cookies?.length ?? 0}`,
        );
      }
    }
  } catch (err) {
    console.log(
      `  ${YELLOW}SKIP${RESET} gateway seed-session — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
