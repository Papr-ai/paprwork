import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPAWN_STDIO_IGNORE_IN } from "../src/core/utils/spawnStdio.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

describe("execShellCommand stream cleanup", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("destroys stdout/stderr streams after successful close", async () => {
    spawnMock.mockImplementation((_shell, _args, options) => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
        stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
        stdin: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
        kill: ReturnType<typeof vi.fn>;
      };
      proc.stdout = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
      });
      proc.stderr = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
      });
      proc.stdin = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
      });
      proc.kill = vi.fn();
      expect(options?.stdio).toEqual(SPAWN_STDIO_IGNORE_IN);
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from("ok\n"));
        proc.emit("close", 0, null);
      });
      return proc;
    });

    const { execShellCommand } = await import("../src/core/utils/shellExec.js");
    await execShellCommand("echo ok", { timeout: 5000 });

    const proc = spawnMock.mock.results[0]?.value as {
      stdout: { destroy: ReturnType<typeof vi.fn> };
      stderr: { destroy: ReturnType<typeof vi.fn> };
      stdin: { destroy: ReturnType<typeof vi.fn> };
    };
    expect(proc.stdout.destroy).toHaveBeenCalled();
    expect(proc.stderr.destroy).toHaveBeenCalled();
    expect(proc.stdin.destroy).toHaveBeenCalled();
  });

  it("destroys streams on spawn error", async () => {
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
        stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
        stdin: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
        kill: ReturnType<typeof vi.fn>;
      };
      proc.stdout = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
      });
      proc.stderr = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
      });
      proc.stdin = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
      });
      proc.kill = vi.fn();
      queueMicrotask(() => {
        proc.emit("error", Object.assign(new Error("spawn EBADF"), { code: "EBADF" }));
      });
      return proc;
    });

    const { execShellCommand } = await import("../src/core/utils/shellExec.js");
    await expect(execShellCommand("false", { timeout: 5000 })).rejects.toMatchObject({
      code: "EBADF",
    });

    const proc = spawnMock.mock.results[0]?.value as {
      stdout: { destroy: ReturnType<typeof vi.fn> };
      stderr: { destroy: ReturnType<typeof vi.fn> };
    };
    expect(proc.stdout.destroy).toHaveBeenCalled();
    expect(proc.stderr.destroy).toHaveBeenCalled();
  });
});
