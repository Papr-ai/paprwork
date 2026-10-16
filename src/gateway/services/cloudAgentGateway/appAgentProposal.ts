/**
 * Contributor edits from the app assistant become a proposal instead of being
 * lost when the sandbox goes away.
 *
 * At materialize we record what each app file looked like (baseline). After a
 * turn we diff the app folder against it and hand the cumulative change set to
 * memory (as an SSE event on the stream it already proxies), which commits it
 * to a contrib branch and opens / updates the PR. Nothing here touches main.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isProposalExcludedAppPath } from "../cloudSync/contributeProposalPaths.js";
import { isLocalScratchPath, isReadmeStub, REGENERATED_FILES } from "../cloudSync/proposalFileMerge.js";

export const PROPOSAL_BASELINE_FILE = ".papr-proposal-baseline.json";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 300;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__"]);

export interface AppProposalFile {
  path: string;
  /** null = deleted. */
  content: string | null;
}

export interface AppProposalChangeSet {
  appId: string;
  baseSha: string | null;
  files: AppProposalFile[];
  /** Changed files that could not be proposed (binary / too large / over budget). */
  skipped: string[];
}

/** Same exclusions as the desktop proposal (contributeChangeSet.skipped). */
function proposable(rel: string): boolean {
  return !isProposalExcludedAppPath(rel) && !isLocalScratchPath(rel) && !REGENERATED_FILES.has(rel);
}

async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, child)));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

const hash = (buf: Buffer) => createHash("sha1").update(buf).digest("hex");

/** Called right after the app repo is copied into the sandbox. */
export async function writeProposalBaseline(paprHome: string, appId: string, headSha: string | null): Promise<void> {
  const appDir = path.join(paprHome, "apps", appId);
  const files: Record<string, string> = {};
  for (const rel of await walk(appDir)) {
    if (!proposable(rel)) continue;
    files[rel] = hash(await fs.readFile(path.join(appDir, rel)));
  }
  await fs.writeFile(
    path.join(paprHome, PROPOSAL_BASELINE_FILE),
    JSON.stringify({ appId, headSha, files }),
    "utf8",
  );
}

/** Cumulative edits since materialize, or null when nothing changed / no baseline. */
export async function collectAppProposalChanges(paprHome: string, appId: string): Promise<AppProposalChangeSet | null> {
  let baseline: { appId: string; headSha: string | null; files: Record<string, string> };
  try {
    baseline = JSON.parse(await fs.readFile(path.join(paprHome, PROPOSAL_BASELINE_FILE), "utf8"));
  } catch {
    return null;
  }
  if (baseline.appId !== appId) return null;
  const appDir = path.join(paprHome, "apps", appId);
  const files: AppProposalFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  const present = new Set<string>();
  for (const rel of (await walk(appDir)).sort()) {
    if (!proposable(rel)) continue;
    present.add(rel);
    const buf = await fs.readFile(path.join(appDir, rel));
    if (baseline.files[rel] === hash(buf)) continue;
    const text = buf.toString("utf8");
    if (rel === "README.md" && isReadmeStub(text)) continue; // desktop ignores stub READMEs too
    const isText = Buffer.from(text, "utf8").equals(buf) && !text.includes("\u0000");
    if (!isText || buf.length > MAX_FILE_BYTES || total + buf.length > MAX_TOTAL_BYTES || files.length >= MAX_FILES) {
      skipped.push(rel);
      continue;
    }
    total += buf.length;
    files.push({ path: rel, content: text });
  }
  for (const rel of Object.keys(baseline.files)) {
    if (!present.has(rel) && files.length < MAX_FILES) files.push({ path: rel, content: null });
  }
  if (files.length === 0 && skipped.length === 0) return null;
  return { appId, baseSha: baseline.headSha, files, skipped };
}
