/**
 * Report unsyncable files in a mini-app folder for agent tools and sync UI.
 */

import {
  listOversizedAppFiles,
  type UnsyncableFile,
} from "../syncV3/collectAppOpFiles.js";

export interface OversizedAppFilesReport {
  paths: UnsyncableFile[];
  message: string;
  /** One line naming what is actually wrong, e.g. "2 over 10 MB, 1 media file". */
  summary: string;
}

export function summarizeUnsyncable(paths: readonly UnsyncableFile[]): string {
  const oversized = paths.filter((p) => p.kind === "oversized");
  const media = paths.filter((p) => p.kind === "untracked-media");
  const parts: string[] = [];
  if (oversized.length > 0) {
    const limit = oversized[0]!.reason.replace(/^over /, "");
    parts.push(`${oversized.length} over ${limit}`);
  }
  if (media.length > 0) {
    parts.push(`${media.length} media/archive file${media.length === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

export async function buildOversizedAppFilesReport(
  paprDir: string,
  appId: string,
): Promise<OversizedAppFilesReport | null> {
  const paths = await listOversizedAppFiles(paprDir, appId);
  if (paths.length === 0) {
    return null;
  }

  const lines = paths.slice(0, 5).map((entry) => {
    const repoPath = `apps/${appId}/${entry.path}`;
    return `  • ${repoPath} (${entry.reason})`;
  });
  const more = paths.length - Math.min(paths.length, 5);
  const message =
    `${paths.length} file(s) in this app will not sync to the web:\n` +
    lines.join("\n") +
    (more > 0 ? `\n  • …and ${more} more` : "") +
    `\nStore them with App Files instead — bytes go to object storage and the app keeps a reference.`;

  return {
    paths,
    message,
    summary: summarizeUnsyncable(paths),
  };
}
