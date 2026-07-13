/**
 * External-repo file edits (mini-app / job routing lives in appJobs exports).
 */

import { promises as fs } from "fs";
import path from "path";
import { applyExactStringReplacement } from "../utils/exactStringReplace.js";
import { autoStageFile } from "../utils/gitAutoStage.js";
import { withFileEditLock } from "../utils/fileEditLock.js";

export interface PathEditFileArgs {
  path: string;
  oldString: string;
  newString: string;
  occurrence?: number;
}

export async function runEditExternalFile(
  args: PathEditFileArgs,
): Promise<{
  success: boolean;
  data: {
    path: string;
    occurrencesFound: number;
    occurrenceReplaced: number;
    git_staged?: boolean;
  };
}> {
  const resolvedPath = path.resolve(args.path);
  const displayName = path.basename(resolvedPath);
  const lockKey = `file:${resolvedPath}`;

  let replaceMeta: {
    occurrencesFound: number;
    occurrenceReplaced: number;
  } | null = null;

  await withFileEditLock(lockKey, async () => {
    let content: string;
    try {
      content = await fs.readFile(resolvedPath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new Error(
          `File not found: ${resolvedPath}. Use read_file or list_directory first.`,
        );
      }
      throw err;
    }

    const applied = applyExactStringReplacement({
      content,
      filename: displayName,
      oldString: args.oldString,
      newString: args.newString,
      occurrence: args.occurrence,
      linesToolName: "edit_file with more surrounding context in oldString",
    });
    replaceMeta = {
      occurrencesFound: applied.occurrencesFound,
      occurrenceReplaced: applied.occurrenceReplaced,
    };

    await fs.writeFile(resolvedPath, applied.newContent, "utf8");
  });

  const gitResult = await autoStageFile(resolvedPath);

  try {
    const { getAgentFocusContextService } = await import(
      "../../gateway/services/AgentFocusContextService.js"
    );
    getAgentFocusContextService().recordAbsolutePathEdit(resolvedPath);
  } catch {
    // Focus tracking is best-effort
  }

  return {
    success: true,
    data: {
      path: resolvedPath,
      occurrencesFound: replaceMeta!.occurrencesFound,
      occurrenceReplaced: replaceMeta!.occurrenceReplaced,
      git_staged: gitResult.staged,
    },
  };
}
