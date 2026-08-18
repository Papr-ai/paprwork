/**
 * Make the job-side Python SDK importable without copying it into every job.
 *
 * Jobs get `PYTHONPATH` pointed at the bundled `job-sdk/` directory, so
 * `from papr_files import add` works from any Python job with no pip install
 * and no vendored copy. Copying the helper into each job folder — the way
 * `papr_db.py` is scaffolded for app backends — would mean every fix has to be
 * re-applied to every job that ever took a copy.
 *
 * The user's own `PYTHONPATH` is preserved and takes precedence: appending
 * rather than replacing means a job that deliberately shadows a module still
 * wins, and we never silently break an environment we did not create.
 */

import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

let cachedRoot: string | null | undefined;

/**
 * Locate `job-sdk/`, which lives at `src/resources/job-sdk` in a dev checkout
 * and `dist/resources/job-sdk` in a packaged build. Both are probed because
 * this same code runs in both, and guessing wrong yields an import error deep
 * inside a user's job rather than here.
 */
export function getJobSdkRoot(): string | null {
  if (cachedRoot !== undefined) {
    return cachedRoot;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist/gateway/services/jobs → dist/resources/job-sdk
    path.resolve(here, "../../../resources/job-sdk"),
    // src/gateway/services/jobs → src/resources/job-sdk
    path.resolve(here, "../../../../src/resources/job-sdk"),
    path.resolve(here, "../../../../resources/job-sdk"),
  ];

  cachedRoot = candidates.find((dir) => existsSync(path.join(dir, "papr_files.py"))) ?? null;
  if (!cachedRoot) {
    console.warn(
      "[JobSdk] job-sdk/ not found — `from papr_files import add` will fail in jobs.",
    );
  }
  return cachedRoot;
}

/** PYTHONPATH entry for the bundled job SDK, merged with any existing value. */
export function jobSdkEnv(
  existingPythonPath?: string,
): Record<string, string> {
  const root = getJobSdkRoot();
  if (!root) {
    return {};
  }

  const parts = existingPythonPath ? [existingPythonPath, root] : [root];
  return { PYTHONPATH: parts.join(path.delimiter) };
}
