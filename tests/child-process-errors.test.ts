import { describe, expect, it } from "vitest";
import {
  classifyChildProcessError,
  formatSpawnErrorForLogs,
} from "../src/core/utils/childProcessErrors.js";

describe("classifyChildProcessError", () => {
  it("treats EBADF as spawn_error, not shell exit code", () => {
    const result = classifyChildProcessError({
      code: "EBADF",
      message: "spawn EBADF",
    });

    expect(result).toMatchObject({
      type: "spawn_error",
      exitCode: -1,
    });
    expect(result?.message).toContain("EBADF");
    expect(result?.message).not.toContain("exit code");
    expect(result?.agentHint).toContain("Retry the command once");
  });

  it("treats numeric code as shell exit code", () => {
    const result = classifyChildProcessError({
      code: 1,
      stdout: "",
      stderr: "error",
    });

    expect(result).toEqual({
      type: "execution_error",
      message: "Command failed with exit code 1",
      exitCode: 1,
    });
  });

  it("detects timeout from killed signal", () => {
    const result = classifyChildProcessError(
      { killed: true, signal: "SIGTERM", code: null },
      5000,
    );

    expect(result?.type).toBe("timeout_error");
    expect(result?.message).toContain("5000ms");
  });

  it("formats spawn messages in job logs", () => {
    expect(formatSpawnErrorForLogs("spawn EBADF")).toContain(
      "Could not start command",
    );
    expect(formatSpawnErrorForLogs("spawn EBADF")).not.toBe("spawn EBADF");
  });
});
