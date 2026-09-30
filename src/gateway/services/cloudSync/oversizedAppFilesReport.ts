/**
 * Report unsyncable files in a mini-app folder for agent tools and sync UI.
 */

import { listOversizedAppFiles } from "../syncV3/collectAppOpFiles.js";

export interface OversizedAppFilesReport {
  paths: Array<{ path: string; sizeBytes: number; reason: string }>;
  message: string;
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
  };
}
