/**
 * Regression test for "spawn EBADF" (GitHub #117, #122, #126, #139, #143).
 *
 * Root cause: macOS libc rejects any fd NUMBER ≥ OPEN_MAX (10240) inside
 * posix_spawn_file_actions_adddup2/addclose with EBADF, regardless of
 * `ulimit -n`. libuv uses posix_spawn on macOS, and Node allocates the child's
 * stdio pipes at the lowest free fd. Once the gateway's fd table is packed up
 * to ~10232, every piped spawn fails; `stdio: "ignore"` still works.
 *
 * This test pins the mechanism so a future watcher/db-handle regression that
 * packs the table again is caught by CI instead of by users.
 */
import { afterEach, describe, expect, it } from "vitest";
import { closeSync, openSync } from "fs";
import { spawnSync } from "child_process";
import {
  DARWIN_SPAWN_FD_CEILING,
  classifyFdPressure,
  isSpawnFdCeilingReached,
  sampleOpenFds,
} from "../src/gateway/services/FdWatchdog.js";

const isDarwin = process.platform === "darwin";

describe("spawn EBADF fd ceiling", () => {
  const held: number[] = [];

  afterEach(() => {
    for (const fd of held) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    held.length = 0;
  });

  it("sampleOpenFds reports count and highest fd number", () => {
    const s = sampleOpenFds();
    if (process.platform === "win32") {
      expect(s).toBeNull();
      return;
    }
    expect(s).not.toBeNull();
    expect(s!.count).toBeGreaterThan(2);
    expect(s!.highest).toBeGreaterThanOrEqual(s!.count - 1);
  });

  it("pressure is classified on highest fd number, not count", () => {
    expect(classifyFdPressure(100, 8000, 9500)).toBe("ok");
    expect(classifyFdPressure(8000, 8000, 9500)).toBe("warn");
    expect(classifyFdPressure(9500, 8000, 9500)).toBe("critical");
    expect(classifyFdPressure(null, 8000, 9500)).toBe("unknown");
    expect(isSpawnFdCeilingReached({ count: 10, highest: 100 })).toBe(false);
    expect(isSpawnFdCeilingReached({ count: 10, highest: DARWIN_SPAWN_FD_CEILING })).toBe(
      isDarwin,
    );
  });

  it.skipIf(!isDarwin)(
    "piped spawn fails with EBADF once highest fd ≥ OPEN_MAX; stdio ignore survives",
    () => {
      // Pack the table past OPEN_MAX. rlimit is far above this on dev machines;
      // if it is not, the test is inconclusive rather than a failure.
      try {
        let last = 0;
        while (last < DARWIN_SPAWN_FD_CEILING + 20) {
          last = openSync("/dev/null", "r");
          held.push(last);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EMFILE") {
          return;
        }
        throw error;
      }

      expect(isSpawnFdCeilingReached()).toBe(true);

      const piped = spawnSync("/bin/sh", ["-c", "true"], { stdio: ["ignore", "pipe", "pipe"] });
      expect((piped.error as NodeJS.ErrnoException | undefined)?.code).toBe("EBADF");

      const ignored = spawnSync("/bin/sh", ["-c", "true"], { stdio: "ignore" });
      expect(ignored.error).toBeUndefined();
      expect(ignored.status).toBe(0);

      // Freeing HIGH-numbered fds (what the tree-watcher migration does) recovers
      // spawning even though the count is still large.
      for (let i = 0; i < 60; i++) {
        closeSync(held.pop()!);
      }
      expect(isSpawnFdCeilingReached()).toBe(false);
      const recovered = spawnSync("/bin/sh", ["-c", "true"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(recovered.error).toBeUndefined();
      expect(recovered.status).toBe(0);
    },
  );
});
