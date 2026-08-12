const OPT_OUT = new Set(["0", "false", "no"]);

/** When true, job runtime lives in gitignored files + memory heartbeat — not git. Default: on. */
export function isJobRuntimeOffGit(): boolean {
  const raw = process.env.JOB_RUNTIME_OFF_GIT?.trim().toLowerCase();
  if (!raw) return true;
  if (OPT_OUT.has(raw)) return false;
  return raw === "1" || raw === "true" || raw === "yes";
}
