/**
 * Block an app's OWN id written as a literal in app or job code.
 *
 * Every install of an app gets a new local id, so a hard-coded id makes copies
 * talk to the original app (or forces install/proposal to find-and-replace
 * code). Code never needs it:
 *   - mini-app frontend: /api/* calls work without `appId` — the gateway and
 *     apps.papr.ai resolve the calling app from the request.
 *   - app backend handlers and jobs: read the `PAPR_APP_ID` env var.
 *   - job commands / agent-job prompts: write `{{papr.app_id}}`.
 *
 * Platform records (metadata.json, linked-databases.json, data-sources.json,
 * job.json, papr-cloud-*.json) legitimately hold ids and are not scanned —
 * only code files are. Ids of OTHER apps are allowed.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ValidationIssue } from "../services/AppService.js";

const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|html?|css|py|sh|rb|go)$/i;
const SKIP_DIRS = new Set(["node_modules", "dist", "__pycache__", "venv", ".venv", "logs", "data"]);
const MAX_FILE_BYTES = 512 * 1024;

export const OWN_APP_ID_RULE = "no-hardcoded-own-app-id";

export const OWN_APP_ID_REMEDIATION =
  "Remove the app's own id from code. Frontend /api/* calls (db, access, backend, jobs, client-keys) " +
  "do not need appId — the platform resolves the calling app. Backend handlers and job scripts read " +
  "os.environ['PAPR_APP_ID'] / process.env.PAPR_APP_ID (no hard-coded fallback). Job commands and " +
  "agent-job prompts use {{papr.app_id}}.";

export interface OwnAppIdHit {
  file: string;
  line: number;
}

/** Line numbers in `content` that contain `appId` (case-insensitive). */
export function findOwnAppIdLines(content: string, appId: string): number[] {
  const id = appId.trim().toLowerCase();
  if (!id || !content.toLowerCase().includes(id)) return [];
  const out: number[] = [];
  content.split("\n").forEach((line, i) => {
    if (line.toLowerCase().includes(id)) out.push(i + 1);
  });
  return out;
}

/** Walk `rootDir` and report every code-file line holding `appId`. */
export async function findOwnAppIdLiterals(rootDir: string, appId: string): Promise<OwnAppIdHit[]> {
  const hits: OwnAppIdHit[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile() || !CODE_FILE.test(entry.name)) continue;
      // Root db.ts is platform-generated (rebuilt on validate/install/pull, never proposed).
      if (dir === rootDir && entry.name === "db.ts") continue;
      try {
        const stat = await fs.stat(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = await fs.readFile(full, "utf8");
        const rel = path.relative(rootDir, full).split(path.sep).join("/");
        for (const line of findOwnAppIdLines(content, appId)) hits.push({ file: rel, line });
      } catch {
        // unreadable file: not this lint's concern
      }
    }
  }
  await walk(rootDir);
  return hits;
}

/** validate_app issues for the app's own id in its code. */
export async function checkOwnAppIdLiterals(appPath: string, appId: string): Promise<ValidationIssue[]> {
  const hits = await findOwnAppIdLiterals(appPath, appId);
  return hits.map((hit) => ({
    file: hit.file,
    line: hit.line,
    severity: "error" as const,
    rule: OWN_APP_ID_RULE,
    message: `Hard-coded app id ${appId} — copies of this app get a different id. ${OWN_APP_ID_REMEDIATION}`,
  }));
}
