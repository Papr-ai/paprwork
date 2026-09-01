import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPAWN_STDIO_IGNORE_IN } from "../src/core/utils/spawnStdio.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

describe("execShellCommand", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  function mockSuccessfulSpawn(stdoutText = "hello\n"): void {
    spawnMock.mockImplementation((_shell, _args, options) => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      expect(options?.stdio).toEqual(SPAWN_STDIO_IGNORE_IN);
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from(stdoutText));
        proc.emit("close", 0, null);
      });
      return proc;
    });
  }

  it("spawns with stdin ignored to avoid Gateway EBADF", async () => {
    mockSuccessfulSpawn("hello\n");
    const { execShellCommand } = await import("../src/core/utils/shellExec.js");

    const { stdout } = await execShellCommand("echo hello", { timeout: 5000 });
    expect(stdout.trim()).toBe("hello");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-zero exit with stderr attached", async () => {
    spawnMock.mockImplementation((_shell, _args, options) => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      expect(options?.stdio).toEqual(SPAWN_STDIO_IGNORE_IN);
      queueMicrotask(() => {
        proc.stderr.emit("data", Buffer.from("boom"));
        proc.emit("close", 7, null);
      });
      return proc;
    });

    const { execShellCommand } = await import("../src/core/utils/shellExec.js");
    await expect(execShellCommand("false", { timeout: 5000 })).rejects.toMatchObject({
      code: 7,
      stderr: "boom",
    });
  });
});
