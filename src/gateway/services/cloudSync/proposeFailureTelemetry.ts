/**
 * Telemetry for a proposal (Send to owner / Publish now) that fails on this
 * desktop. Without it a failed push only reached the user's screen: the
 * server saw prepare and then nothing, so support could not tell why.
 */

/** The step of CloudAppContributeService.propose that was running. */
export type ProposeStep =
  | "lineage"
  | "prepare"
  | "push"
  | "publish_database"
  | "submit"
  | "after_submit";

export interface ProposeFailureProps {
  step: ProposeStep;
  error_code: string;
  http_status?: number;
  error_message: string;
  publish_now: boolean;
  installed_app_id: string;
  request_id?: string;
}

/** Remove anything that could carry a credential, then cap the length. */
export function scrubProposeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s'")]+/g, "<url>")
    .replace(/\b(ghs|ghp|gho|ghu|ghr)_[A-Za-z0-9]+/g, "<token>")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "<token>")
    .replace(/x-access-token:[^@\s]+/g, "x-access-token:<token>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Short, stable code for charts. Message text varies; this doesn't. */
export function classifyProposeError(err: unknown): { code: string; httpStatus?: number } {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : String(err);
  if (typeof e?.code === "string" && e.code) return { code: e.code };
  if (e?.name === "GitHubPausedError") return { code: "github_paused" };

  const http = /^(Prepare|Submit) contribute failed \((\d{3})\)/.exec(message);
  if (http) {
    return { code: `${http[1].toLowerCase()}_http`, httpStatus: Number(http[2]) };
  }
  if (/No changes to contribute/i.test(message)) return { code: "no_changes" };
  if (/Couldn't tell which version/i.test(message)) return { code: "base_unknown" };
  if (/timed? ?out|ETIMEDOUT/i.test(message)) return { code: "timeout" };
  if (/\bgit\b|remote:|fatal:/i.test(message)) return { code: "git_error" };
  return { code: "unknown" };
}

export function proposeFailureProps(
  err: unknown,
  ctx: { step: ProposeStep; publishNow: boolean; installedAppId: string; requestId?: string },
): ProposeFailureProps {
  const { code, httpStatus } = classifyProposeError(err);
  const raw = err instanceof Error ? err.message : String(err);
  return {
    step: ctx.step,
    error_code: code,
    ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    error_message: scrubProposeErrorMessage(raw),
    publish_now: ctx.publishNow,
    installed_app_id: ctx.installedAppId,
    ...(ctx.requestId ? { request_id: ctx.requestId } : {}),
  };
}
