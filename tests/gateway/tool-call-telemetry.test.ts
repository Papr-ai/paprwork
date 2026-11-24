import { describe, expect, it } from "vitest";
import {
  categorizeToolError,
  commandHead,
  toolFailureTelemetry,
} from "../../src/core/telemetry/toolCallTelemetry.js";
import { sanitizeTelemetryProperties } from "../../src/core/telemetry/sanitizeTelemetryProperties.js";

describe("categorizeToolError", () => {
  it.each([
    ["'grep' is not recognized as an internal or external command,", "command_not_found"],
    ["bash: jq: command not found", "command_not_found"],
    ["& was unexpected at this time.", "syntax_error"],
    ["The syntax of the command is incorrect.", "syntax_error"],
    ["The system cannot find the path specified.", "path_not_found"],
    ["ls: foo: No such file or directory", "path_not_found"],
    ["Access is denied.", "permission_denied"],
  ])("%s -> %s", (text, cat) => {
    expect(categorizeToolError(text, "execution_error")).toBe(cat);
  });

  it("uses error type for timeouts/spawn/validation", () => {
    expect(categorizeToolError("", "timeout_error")).toBe("timeout");
    expect(categorizeToolError("", "spawn_error")).toBe("spawn_error");
    expect(categorizeToolError("", "validation_error")).toBe("validation_error");
    expect(categorizeToolError("boom", "execution_error")).toBe("nonzero_exit");
  });
});

describe("commandHead", () => {
  it("returns only the program name", () => {
    expect(commandHead("ls -la /Users/secret")).toBe("ls");
    expect(commandHead("C:\\\\tools\\\\Python.exe script.py")).toBe("python");
    expect(commandHead("cd C:\\\\proj && npm install")).toBe("npm");
    expect(commandHead("\"/usr/bin/git\" status")).toBe("git");
    expect(commandHead("")).toBe("");
    expect(commandHead(undefined)).toBe("");
  });
});

describe("toolFailureTelemetry", () => {
  const winFail = {
    success: false,
    error: "Command failed with exit code 1",
    type: "execution_error",
    data: {
      stdout: "",
      stderr: "'head' is not recognized as an internal or external command,\r\noperable program or batch file.",
      exitCode: 1,
      command: "cat C:\\\\Users\\\\jessica\\\\notes.txt | head -5",
    },
  };

  it("adds category, exit code, shell and command head for failed bash", () => {
    const props = toolFailureTelemetry("bash", winFail);
    expect(props).toMatchObject({
      error_category: "command_not_found",
      error_type: "execution_error",
      exit_code: 1,
      command_head: "cat",
    });
    expect(typeof props.shell).toBe("string");
  });

  it("never leaks raw stderr, args or paths", () => {
    const json = JSON.stringify(sanitizeTelemetryProperties(toolFailureTelemetry("bash", winFail)));
    expect(json).not.toMatch(/jessica|notes\.txt|recognized|head -5/);
  });

  it("only adds shell for successful bash, nothing for other successful tools", () => {
    expect(Object.keys(toolFailureTelemetry("bash", { success: true, data: { exitCode: 0 } }))).toEqual(["shell"]);
    expect(toolFailureTelemetry("write_file", { success: true })).toEqual({});
  });

  it("handles non-bash errors without command fields", () => {
    expect(toolFailureTelemetry("create_app", { error: "boom" })).toEqual({ error_category: "other" });
  });
});
