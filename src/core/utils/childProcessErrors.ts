/**
 * Classify Node.js child_process failures for clearer agent + user messaging.
 *
 * Node reports spawn failures (EBADF, EMFILE, ENOENT, …) with string `error.code`,
 * but exec() also uses numeric `error.code` for shell exit codes. Without
 * distinguishing these, agents see "exit code EBADF" and misdiagnose OS shell failure.
 */

const SPAWN_ERROR_CODES = new Set([
  "EBADF",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "EAGAIN",
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "ENOMEM",
  "EINVAL",
]);

export type ChildProcessFailureType =
  | "spawn_error"
  | "timeout_error"
  | "execution_error";

export interface ChildProcessFailure {
  type: ChildProcessFailureType;
  message: string;
  exitCode: number;
  /** Actionable guidance for the agent (included in tool result when present). */
  agentHint?: string;
}

interface NodeExecError {
  code?: number | string;
  message?: string;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
}

function spawnCodeFromError(err: NodeExecError): string {
  if (typeof err.code === "string") {
    return err.code;
  }
  const match = err.message?.match(/^spawn\s+(\S+)/i);
  return match?.[1] ?? "UNKNOWN";
}

function isSpawnFailure(err: NodeExecError): boolean {
  if (typeof err.code === "string") {
    return SPAWN_ERROR_CODES.has(err.code) || !/^\d+$/.test(err.code);
  }
  return typeof err.message === "string" && /^spawn\s/i.test(err.message);
}

function spawnMessage(code: string): string {
  switch (code) {
    case "EBADF":
      return (
        "Could not start command — Paprwork could not open process pipes (EBADF). " +
        "This is a Gateway process issue, not your shell script failing."
      );
    case "EMFILE":
    case "ENFILE":
      return (
        `Could not start command — too many open files (${code}). ` +
        "Paprwork needs a full quit and relaunch."
      );
    case "ENOENT":
      return "Could not start command — shell or executable not found (ENOENT).";
    case "EACCES":
    case "EPERM":
      return `Could not start command — permission denied (${code}).`;
    default:
      return `Could not start command — process spawn failed (${code}).`;
  }
}

function spawnAgentHint(code: string): string {
  switch (code) {
    case "EBADF":
    case "EMFILE":
    case "ENFILE":
      return (
        "Do NOT tell the user the OS shell is 'jammed'. " +
        "Ask them to fully quit Paprwork (Cmd+Q / File → Quit) and relaunch. " +
        "Prefer write_file + run_job over long inline python heredocs in bash. " +
        "Avoid rapid back-to-back bash calls until Paprwork is restarted."
      );
    case "ENOENT":
      return "Verify the executable path exists. For Python jobs, use run_job with a script file under code/.";
    default:
      return "If this persists after relaunching Paprwork, use run_job instead of bash for the script.";
  }
}

/**
 * Map a Node child_process error to a structured failure for tool responses.
 * Returns null when the error shape is not recognized.
 */
export function classifyChildProcessError(
  error: unknown,
  timeoutMs = 60_000,
): ChildProcessFailure | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const err = error as NodeExecError;

  if (err.killed || err.signal === "SIGTERM" || err.signal === "SIGKILL") {
    return {
      type: "timeout_error",
      message: `Command timed out after ${timeoutMs}ms`,
      exitCode: typeof err.code === "number" ? err.code : -1,
    };
  }

  if (isSpawnFailure(err)) {
    const code = spawnCodeFromError(err);
    return {
      type: "spawn_error",
      message: spawnMessage(code),
      exitCode: -1,
      agentHint: spawnAgentHint(code),
    };
  }

  if (typeof err.code === "number") {
    return {
      type: "execution_error",
      message: `Command failed with exit code ${err.code}`,
      exitCode: err.code,
    };
  }

  return null;
}

/** Format spawn errors consistently for job logs and tool surfaces. */
export function formatSpawnErrorForLogs(message: string): string {
  if (/^spawn\s/i.test(message)) {
    const code = message.replace(/^spawn\s/i, "").trim();
    return spawnMessage(code);
  }
  return message;
}
