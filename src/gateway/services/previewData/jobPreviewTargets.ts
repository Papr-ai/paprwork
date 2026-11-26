/**
 * Jobs and Preview (gap 3): a job started from the Preview frame (or by Pen
 * with PAPR_DATA_TARGET=preview) reads and writes the same test copy Preview
 * shows, so it can use the pending fields and never writes test rows to the
 * team's data. Started from Live, a schedule or anywhere else: the real data.
 */
import type { JobWriteDatabaseTarget } from "../jobAppDatabase.js";
import type { AppDataSource } from "../appDataSources.js";

export const DATA_TARGET_PARAM = "PAPR_DATA_TARGET";

/** Param the gateway adds when /api/jobs/run comes from a Preview or proposal frame. */
export async function dataTargetParamFromReferer(referer: string | undefined): Promise<Record<string, string>> {
  const { isPreviewRequest } = await import("./previewDataCopy.js");
  const { proposalFromReferer } = await import("./proposalPreview.js");
  const pr = proposalFromReferer(referer);
  if (pr) return { [DATA_TARGET_PARAM]: `proposal:${pr}` };
  return isPreviewRequest(referer) ? { [DATA_TARGET_PARAM]: "preview" } : {};
}

export interface JobPreviewDeps {
  previewFor: (appId: string, source: AppDataSource) => Promise<AppDataSource | null>;
  proposalFor: (appId: string, requestId: string, source: AppDataSource) => Promise<AppDataSource>;
}

async function defaultDeps(): Promise<JobPreviewDeps> {
  const { previewSourceFor } = await import("./previewDataCopy.js");
  const { proposalDataSource } = await import("./proposalPreview.js");
  return { previewFor: (a, s) => previewSourceFor(a, s), proposalFor: (a, r, s) => proposalDataSource(a, r, s) };
}

/**
 * Swap each write target for its test copy when the run asked for Preview.
 * A target with no test copy (no pending change) keeps the real data. The
 * swapped target is a plain local file: no proxy, nothing syncs.
 */
export async function applyJobDataTarget(
  targets: JobWriteDatabaseTarget[],
  appId: string | undefined,
  params: Record<string, string> | undefined,
  deps?: JobPreviewDeps,
): Promise<{ targets: JobWriteDatabaseTarget[]; note: string | null }> {
  const want = params?.[DATA_TARGET_PARAM]?.trim();
  if (!want || !appId || want === "live" || targets.length === 0) return { targets, note: null };
  const d = deps ?? (await defaultDeps());
  const swapped: string[] = [];
  const out: JobWriteDatabaseTarget[] = [];
  for (const t of targets) {
    const real: AppDataSource = { id: t.dbId, type: "sqlite", alias: t.alias, dbPath: t.dbPath, dbId: t.dbId, tables: [], linkedAt: "" };
    const copy = want.startsWith("proposal:")
      ? await d.proposalFor(appId, want.slice("proposal:".length), real).catch(() => null)
      : await d.previewFor(appId, real).catch(() => null);
    if (copy) {
      out.push({ ...t, dbPath: copy.dbPath, syncMode: "legacy" });
      swapped.push(t.alias);
    } else out.push(t);
  }
  return {
    targets: out,
    note: swapped.length > 0 ? `Preview run: ${swapped.join(", ")} use the test copy (rows are thrown away).` : null,
  };
}
