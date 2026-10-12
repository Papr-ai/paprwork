/**
 * Who last published into an app from someone else's machine (v9).
 *
 * A Maintainer's Accept / Publish now reaches the publisher as a
 * `proposal.merged` event. Instead of a notification, the share bar's status
 * dialog reads this file and says "Published by Shawkat · Fix chart labels".
 */

import { promises as fs } from "fs";
import path from "path";

export interface LastMerge {
  appId: string;
  actorUserId: string | null;
  title: string | null;
  publishedDirectly: boolean;
  at: string;
}

const FILE = path.join("data", "cloud-last-merge.json");

async function readAll(paprDir: string): Promise<Record<string, LastMerge>> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(paprDir, FILE), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, LastMerge>) : {};
  } catch {
    return {};
  }
}

export async function recordLastMerges(paprDir: string, merges: LastMerge[]): Promise<void> {
  if (merges.length === 0) return;
  const all = await readAll(paprDir);
  for (const m of merges) {
    const prev = all[m.appId];
    if (!prev || prev.at <= m.at) all[m.appId] = m;
  }
  const target = path.join(paprDir, FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  await fs.rename(tmp, target);
}

export async function readLastMerge(paprDir: string, appId: string): Promise<LastMerge | null> {
  return (await readAll(paprDir))[appId] ?? null;
}
