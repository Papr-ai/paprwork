/**
 * Failure detail for `paprwork_tool_called`, kept privacy-safe.
 *
 * We never send raw stderr or the full command (they can hold paths, names,
 * secrets). Instead we send:
 *  - error_type / exit_code from the tool result
 *  - error_category: a coarse bucket derived from stderr/error text
 *  - command_head: the first program name in the command (e.g. "ls", "grep")
 *  - shell: which shell executed it (cmd / powershell / bash / zsh / …)
 */

export type ToolErrorCategory =
  | "command_not_found"
  | "syntax_error"
  | "path_not_found"
  | "permission_denied"
  | "timeout"
  | "spawn_error"
  | "validation_error"
  | "nonzero_exit"
  | "other";

const NOT_FOUND = [
  /is not recognized as an internal or external command/i,
  /is not recognized as the name of a cmdlet/i,
  /command not found/i,
];
const SYNTAX = [
  /was unexpected at this time/i,
  /syntax error/i,
  /unexpected token/i,
  /the syntax of the command is incorrect/i,
  /unterminated|unexpected EOF/i,
];
const PATH = [
  /the system cannot find the (path|file)/i,
  /no such file or directory/i,
  /cannot find path/i,
];
const PERM = [/access is denied/i, /permission denied/i, /EACCES|EPERM/];

export function categorizeToolError(
  text: string,
  errorType?: string,
): ToolErrorCategory {
  if (errorType === "timeout_error") return "timeout";
  if (errorType === "spawn_error") return "spawn_error";
  if (errorType === "validation_error") return "validation_error";
  if (NOT_FOUND.some((r) => r.test(text))) return "command_not_found";
  if (SYNTAX.some((r) => r.test(text))) return "syntax_error";
  if (PATH.some((r) => r.test(text))) return "path_not_found";
  if (PERM.some((r) => r.test(text))) return "permission_denied";
  if (errorType === "execution_error") return "nonzero_exit";
  return "other";
}

/** First program name only, lowercased, no path/args. "" when unknowable. */
export function commandHead(command: unknown): string {
  if (typeof command !== "string") return "";
  const first = command.trim().replace(/^(sudo|cd\s+\S+\s*(&&|;))\s*/i, "");
  const m = first.match(/^["']?([^\s"'|;&<>()]+)/);
  if (!m) return "";
  const base = m[1].split(/[\\/]/).pop() ?? "";
  const name = base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
  return /^[a-z0-9._+-]{1,32}$/.test(name) ? name : "";
}

export function currentShellName(): string {
  const shell =
    process.platform === "win32"
      ? process.env.COMSPEC || "cmd.exe"
      : process.env.SHELL || "/bin/bash";
  const base = (shell.split(/[\\/]/).pop() ?? "").toLowerCase();
  return base.replace(/\.exe$/, "") || "unknown";
}

/**
 * Extra properties for a tool call. bash always gets `shell` (so failure
 * rates can be split by shell); failures also get error detail.
 */
export function toolFailureTelemetry(
  toolName: string,
  result: unknown,
): Record<string, string | number> {
  const base: Record<string, string | number> =
    toolName === "bash" ? { shell: currentShellName() } : {};
  if (!result || typeof result !== "object") return base;
  const r = result as Record<string, unknown>;
  const failed = "error" in r || r.success === false;
  if (!failed) return base;
  const data = (r.data && typeof r.data === "object" ? r.data : {}) as Record<
    string,
    unknown
  >;
  const errorType = typeof r.type === "string" ? r.type : undefined;
  const text = [r.error, data.stderr].filter((v) => typeof v === "string").join("\n");
  const props: Record<string, string | number> = {
    ...base,
    error_category: categorizeToolError(text, errorType),
  };
  if (errorType) props.error_type = errorType.slice(0, 40);
  if (typeof data.exitCode === "number") props.exit_code = data.exitCode;
  if (toolName === "bash") {
    const head = commandHead(data.command);
    if (head) props.command_head = head;
  }
  return props;
}
