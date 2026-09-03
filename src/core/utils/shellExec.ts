import { spawn } from "child_process";
import { getShellCommand } from "./platform.js";
import { SPAWN_STDIO_IGNORE_IN } from "./spawnStdio.js";
import { destroyChildProcessStreams } from "./destroyChildProcessStreams.js";
import { notifySpawnResourceError } from "./spawnResourceErrorHandler.js";

export interface ShellExecOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

export interface ShellExecError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
}

/**
 * Run a shell command with stdin ignored (prevents EBADF from inherited stdin).
 * Matches child_process.exec semantics: non-zero exit rejects with stdout/stderr attached.
 */
export function execShellCommand(
  command: string,
  options: ShellExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const {
    cwd = process.cwd(),
    timeout = 30_000,
    env,
    maxBuffer = 100 * 1024 * 1024,
  } = options;

  return new Promise((resolve, reject) => {
    const [shellPath, shellArgs] = getShellCommand(command);
    const proc = spawn(shellPath, shellArgs, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: SPAWN_STDIO_IGNORE_IN,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (): void => {
      destroyChildProcessStreams(proc);
    };

    const fail = (err: ShellExecError): void => {
      if (settled) return;
      settled = true;
      err.stdout = stdout;
      err.stderr = stderr;
      finish();
      reject(err);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > maxBuffer) {
        proc.kill("SIGKILL");
        fail(
          Object.assign(new Error("stdout maxBuffer exceeded"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            killed: true,
          }),
        );
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > maxBuffer) {
        proc.kill("SIGKILL");
        fail(
          Object.assign(new Error("stderr maxBuffer exceeded"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            killed: true,
          }),
        );
      }
    });

    const timer =
      timeout > 0
        ? setTimeout(() => {
            if (!proc.killed) {
              proc.kill("SIGKILL");
              fail(
                Object.assign(new Error(`Command timed out after ${timeout}ms`), {
                  killed: true,
                  signal: "SIGKILL",
                }),
              );
            }
          }, timeout)
        : null;

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      notifySpawnResourceError(err, "shellExec spawn");
      fail(err);
    });

    proc.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (settled) return;

      if (code === 0) {
        settled = true;
        finish();
        resolve({ stdout, stderr });
        return;
      }

      fail(
        Object.assign(
          new Error(
            signal
              ? `Command terminated by signal ${signal}`
              : `Command failed with exit code ${code}`,
          ),
          { code: code ?? undefined, stdout, stderr, killed: false, signal: signal ?? undefined },
        ),
      );
    });
  });
}
