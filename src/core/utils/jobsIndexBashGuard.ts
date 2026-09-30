const JOBS_INDEX_WRITE_RE =
  /(?:>|>>|\btee\b|\bsponge\b|\bsed\s+-i|\bcat\s+>\s|\bpython3?\s+-c|\bnode\s+-e)/i;

const JOBS_INDEX_PATH_RE =
  /(?:~\/Papr\/data\/jobs\.json|Papr\/data\/jobs\.json|\.paprwork(?:-v2)?\/data\/jobs\.json|\/data\/jobs\.json)/i;

export const JOBS_INDEX_BASH_BLOCK_MESSAGE =
  "⛔ Do not create or edit jobs via bash/jq on jobs.json. " +
  "Use create_job({ name, type, appIds, command, ... }) to create jobs (auto-creates $PAPR_HOME/Jobs/{id}/ + index entry). " +
  "Use update_job({ jobId, ... }) to change job config or status. " +
  "Use reload_jobs() after external status fixes. " +
  "Manual jobs.json edits race with JobsService and orphan job directories.";

/**
 * Returns true when a bash command likely mutates the jobs index file.
 * Read-only inspection (cat, jq without redirect, grep) is allowed.
 */
export function isJobsIndexBashWriteBlocked(command: string): boolean {
  if (!JOBS_INDEX_PATH_RE.test(command)) {
    return false;
  }
  if (JOBS_INDEX_WRITE_RE.test(command)) {
    return true;
  }
  if (/\bjq\b/i.test(command) && /(?:>|>>|\bsponge\b)/.test(command)) {
    return true;
  }
  return false;
}
