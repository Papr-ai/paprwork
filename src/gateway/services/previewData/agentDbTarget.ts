/**
 * Agent DB tools (papr_db_query / papr_db_exec) and Preview vs Live (plan §7):
 *  1. When the app has a preview of this database, `target` is required. No silent default.
 *  2. Every result names its target ("preview of <app>" / "team's live data").
 *  4. A teammate writing Live rows on the team's data must confirm with the user first.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { AppDataSource } from "../appDataSources.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";

export type DbTarget = "preview" | "live";

export interface ResolvedTarget {
  source: AppDataSource;
  target: DbTarget;
  /** Shown to the agent and repeated to the user. */
  label: string;
  /** Teammate on the team's shared data (Live writes need confirmation). */
  teamData: boolean;
}

/** Apps on this computer that link dbId (data-sources.json). */
async function appsLinking(dbId: string, paprRoot: string): Promise<Array<{ appId: string; title: string }>> {
  const appsDir = path.join(paprRoot, "apps");
  const out: Array<{ appId: string; title: string }> = [];
  for (const appId of await fs.readdir(appsDir).catch(() => [] as string[])) {
    const raw = await fs.readFile(path.join(appsDir, appId, "data-sources.json"), "utf8").catch(() => null);
    if (!raw || !raw.includes(dbId)) continue;
    const meta = await fs.readFile(path.join(appsDir, appId, "metadata.json"), "utf8").catch(() => "{}");
    let title = appId;
    try {
      title = (JSON.parse(meta) as { title?: string }).title ?? appId;
    } catch {
      /* keep id */
    }
    out.push({ appId, title });
  }
  return out;
}

export interface TargetDeps {
  isCollaboratorOnShared: (dbId: string) => boolean;
  previewFor: (appId: string, source: AppDataSource) => Promise<AppDataSource | null>;
  paprRoot?: string;
}

async function defaultDeps(): Promise<TargetDeps> {
  const { isCollaboratorOnSharedDatabase } = await import("../sharedPrimaryTursoResolve.js");
  const { previewSourceFor } = await import("./previewDataCopy.js");
  return { isCollaboratorOnShared: isCollaboratorOnSharedDatabase, previewFor: (a, s) => previewSourceFor(a, s) };
}

export async function resolveAgentDbTarget(
  real: AppDataSource,
  opts: { target?: DbTarget; appId?: string },
  deps?: TargetDeps,
): Promise<ResolvedTarget> {
  const d = deps ?? (await defaultDeps());
  const live: ResolvedTarget = { source: real, target: "live", label: "team's live data", teamData: false };
  if (!real.dbId) return { ...live, label: "live data" };
  const teamData = d.isCollaboratorOnShared(real.dbId);
  live.teamData = teamData;
  if (!teamData) {
    // Owners don't have a separate Preview database (schema goes in by publish).
    if (opts.target === "preview") throw new Error("This database has no preview: there's only Live. Say so to the user.");
    return { ...live, label: "live data (no preview for this database)" };
  }
  const apps = (await appsLinking(real.dbId, d.paprRoot ?? getPaprRoot())).filter((a) => !opts.appId || a.appId === opts.appId);
  let preview: { source: AppDataSource; title: string } | null = null;
  for (const a of apps) {
    const pv = await d.previewFor(a.appId, real).catch(() => null);
    if (pv) {
      preview = { source: pv, title: a.title };
      break;
    }
  }
  if (!preview) {
    if (opts.target === "preview") {
      throw new Error("No preview of this database right now (no pending data change), so only the team's live data exists. Say so to the user.");
    }
    return live;
  }
  if (!opts.target) {
    throw new Error(
      `${preview.title} has a preview of this database (a test copy with your pending data change). ` +
        `Pass target: "preview" (test copy, thrown away) or "live" (the team's real data). ` +
        `Default to the view the user has open, and tell them which one you used.`,
    );
  }
  return opts.target === "preview"
    ? { source: preview.source, target: "preview", label: `preview of ${preview.title} (test copy; rows here are thrown away)`, teamData }
    : live;
}

/** Rule 4: Live rows on the team's data are written only after the user said yes. */
export function assertLiveWriteConfirmed(t: ResolvedTarget, confirmed: boolean | undefined, sql: string): void {
  if (t.target !== "live" || !t.teamData || confirmed) return;
  const verb = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "WRITE";
  throw new Error(
    `This ${verb} changes the team's live data, which everyone sees. Ask the user first (say how many rows it ` +
      `touches; count them with papr_db_query), then call again with confirmedWithUser: true. ` +
      `To try it out instead, use target: "preview".`,
  );
}
