import type { ChildProcess } from "child_process";

function destroyStream(
  stream: { destroy?: () => void } | null | undefined,
): void {
  if (stream && typeof stream.destroy === "function") {
    stream.destroy();
  }
}

/** Release stdout/stderr/stdin pipe fds after a child process exits or errors. */
export function destroyChildProcessStreams(proc: ChildProcess | null): void {
  if (!proc) return;
  destroyStream(proc.stdout);
  destroyStream(proc.stderr);
  destroyStream(proc.stdin);
}
