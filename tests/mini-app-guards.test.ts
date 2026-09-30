import path from "path";
import { describe, expect, it } from "vitest";
import { getMiniAppWriteBlockReason, getPaprAppsRoot } from "../src/core/utils/paprRoot.js";
import {
  formatEsbuildErrorMessage,
  isEsbuildInfrastructureError,
} from "../src/gateway/utils/miniAppTranspile.js";

const appsRoot = getPaprAppsRoot();

describe("getMiniAppWriteBlockReason", () => {
  it("allows writes outside ~/Papr/apps", () => {
    expect(getMiniAppWriteBlockReason("/tmp/foo.txt")).toBeNull();
  });

  it("blocks writes to mini-app source files", () => {
    const reason = getMiniAppWriteBlockReason(
      path.join(appsRoot, "abc-123", "app.ts"),
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("write_file");
    expect(reason).toContain("abc-123");
    expect(reason).toContain("app.ts");
  });

  it("blocks writes to dist/", () => {
    const reason = getMiniAppWriteBlockReason(
      path.join(appsRoot, "abc-123", "dist", "app.js"),
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("dist/");
    expect(reason).toContain("validate_app");
  });
});

describe("esbuild infrastructure error formatting", () => {
  it("detects missing platform binary", () => {
    const raw =
      'The package "@esbuild/darwin-arm64" could not be found, and is needed by esbuild.';
    expect(isEsbuildInfrastructureError(raw)).toBe(true);
    expect(formatEsbuildErrorMessage(raw)).toContain("NOT an app code bug");
    expect(formatEsbuildErrorMessage(raw)).toContain("npm install");
  });

  it("passes through normal syntax errors unchanged", () => {
    const raw = 'Expected ">" but found "class"';
    expect(isEsbuildInfrastructureError(raw)).toBe(false);
    expect(formatEsbuildErrorMessage(raw)).toBe(raw);
  });
});
