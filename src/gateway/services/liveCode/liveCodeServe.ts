/**
 * Which files a /apps/{id}/... request reads.
 * "@live/<path>" → the Live copy (data/live-code/{id}); no Live copy yet
 * (never published, or not built) → the app folder, same as Preview.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { liveCodeDir, refreshLiveCodeQuietly, seedLiveCodeIfMissing } from "./liveCodeCopy.js";

export const LIVE_PREFIX = "@live/";

export interface LiveServe {
  /** Path inside the app ("index.html", "dist/app.js"). */
  path: string;
  /** Live copy root, or null to read the app folder. */
  dir: string | null;
  resolve: (rel: string) => Promise<string | null>;
}

export async function resolveLiveServe(
  appId: string,
  rawPath: string,
  paprRoot = getPaprRoot(),
): Promise<LiveServe> {
  const { parseProposalPath, proposalPreviewDir } = await import("../previewData/proposalPreview.js");
  const pr = parseProposalPath(rawPath);
  if (pr) {
    // A proposal's preview is only ever its own folder; never falls back to yours.
    const dir = path.join(proposalPreviewDir(appId, pr.requestId, paprRoot), "code");
    return {
      path: pr.rel,
      dir,
      resolve: async (p: string) => {
        const full = path.resolve(dir, p);
        if (!full.startsWith(dir + path.sep)) return null;
        const st = await fs.stat(full).catch(() => null);
        return st?.isFile() ? full : null;
      },
    };
  }
  const isLive = rawPath === "@live" || rawPath.startsWith(LIVE_PREFIX);
  const rel = isLive ? rawPath.slice(LIVE_PREFIX.length) || "index.html" : rawPath;
  const none: LiveServe = { path: rel, dir: null, resolve: async () => null };
  if (!isLive) return none;
  const dir = liveCodeDir(appId, paprRoot);
  if (!(await fs.stat(path.join(dir, "index.html")).catch(() => null))) {
    refreshLiveCodeQuietly(`seed ${appId}`, () => seedLiveCodeIfMissing(appId, paprRoot));
    return none;
  }
  return {
    path: rel,
    dir,
    resolve: async (p: string) => {
      const full = path.resolve(dir, p);
      if (!full.startsWith(dir + path.sep)) return null;
      const st = await fs.stat(full).catch(() => null);
      return st?.isFile() ? full : null;
    },
  };
}
