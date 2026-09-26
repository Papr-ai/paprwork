#!/usr/bin/env node
/**
 * Push a Specific-people allowlist to production Cloud App Host (immediate fix).
 *
 * Usage:
 *   node scripts/push-share-allowlist-to-cloud-host.mjs \
 *     --app-id=d288d2a7-1483-46bc-956d-bdee55fd9b47 \
 *     --namespace=a3huiyLYcU \
 *     --slug=gtm-gap-audit-client-prep
 *
 * Reads allowlist from workspace cloud-publish-prefs.json unless --json= path given.
 * Requires PAPR_CLOUD_APP_HOST_KEY in .env.local (same key Cloud Run uses).
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.join("=") || "true"];
  }),
);

const appId = args["app-id"];
const namespaceId = args.namespace;
const slug = args.slug;
const host = (args.host ?? "https://apps.papr.ai").replace(/\/$/, "");
const jsonPath = args.json;

if (!appId || !namespaceId || !slug) {
  console.error(
    "Required: --app-id= --namespace= --slug=  (optional: --host= --json=)",
  );
  process.exit(1);
}

function loadEnvLocal() {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

function loadAllowlistFromPrefs() {
  const pointerCandidates = [
    join(homedir(), "Papr", "data", "workspace-pointer.json"),
    join(homedir(), ".paprwork-v2", "data", "workspace-pointer.json"),
  ];
  let paprDir = join(homedir(), "Papr");
  for (const pointerPath of pointerCandidates) {
    if (!existsSync(pointerPath)) continue;
    try {
      const ptr = JSON.parse(readFileSync(pointerPath, "utf8"));
      const orgId = (ptr.organizationId ?? ptr.orgId)?.trim();
      const namespaceId = ptr.namespaceId?.trim();
      if (orgId && namespaceId) {
        paprDir = join(homedir(), "Papr", "orgs", orgId, "namespaces", namespaceId);
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!existsSync(join(paprDir, "data", "cloud-publish-prefs.json"))) {
    const nsArg = args.namespace?.trim();
    if (nsArg) {
      const orgsRoot = join(homedir(), "Papr", "orgs");
      if (existsSync(orgsRoot)) {
        for (const org of readdirSync(orgsRoot)) {
          const candidate = join(orgsRoot, org, "namespaces", nsArg, "data", "cloud-publish-prefs.json");
          if (existsSync(candidate)) {
            paprDir = join(orgsRoot, org, "namespaces", nsArg);
            break;
          }
        }
      }
    }
  }
  const prefsPath = join(paprDir, "data", "cloud-publish-prefs.json");
  const raw = readFileSync(prefsPath, "utf8");
  const parsed = JSON.parse(raw);
  const app = parsed.apps?.[appId];
  if (!app) {
    throw new Error(`No prefs for ${appId} in ${prefsPath}`);
  }
  return {
    allowedUserIds: app.allowedUserIds ?? [],
    allowedEmails: app.allowedEmails ?? [],
    allowedEmailDomains: app.allowedEmailDomains ?? [],
  };
}

loadEnvLocal();
const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY?.trim();
if (!hostKey) {
  console.error("PAPR_CLOUD_APP_HOST_KEY missing (set in .env.local)");
  process.exit(1);
}

const body = {
  namespaceId,
  slug,
  appId,
  ...(jsonPath
    ? JSON.parse(readFileSync(jsonPath, "utf8"))
    : loadAllowlistFromPrefs()),
};

const res = await fetch(`${host}/internal/app-access-updated`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Cloud-App-Host-Key": hostKey,
  },
  body: JSON.stringify(body),
});

const text = await res.text();
console.log(res.status, text.slice(0, 500));
if (!res.ok) process.exit(1);
