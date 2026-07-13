import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkBackendManifestIntegrity,
  checkMiniAppBashPatterns,
} from "../src/gateway/utils/miniAppBackendLint.js";

describe("checkMiniAppBashPatterns", () => {
  it("errors on /api/bash/run in frontend source", () => {
    const files = new Map<string, string>([
      [
        "app.ts",
        `await fetch('/api/bash/run', { method: 'POST', body: '{}' });`,
      ],
    ]);
    const issues = checkMiniAppBashPatterns(files);
    expect(issues.some((i) => i.rule === "no-mini-app-bash" && i.severity === "error")).toBe(
      true,
    );
  });

  it("ignores bash references in backend handlers", () => {
    const files = new Map<string, string>([
      ["backend/run.py", "# docs mention /api/bash/run"],
    ]);
    const issues = checkMiniAppBashPatterns(files);
    expect(issues).toHaveLength(0);
  });
});

describe("checkBackendManifestIntegrity", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes when handlers exist", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-manifest-"));
    const backendDir = join(tempDir, "backend");
    await mkdir(backendDir);
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        actions: { ping: { handler: "ping.py", runtime: "python" } },
      }),
    );
    await writeFile(join(backendDir, "ping.py"), "print('ok')");

    const issues = await checkBackendManifestIntegrity(tempDir);
    expect(issues).toHaveLength(0);
  });

  it("errors when handler file is missing", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-manifest-"));
    const backendDir = join(tempDir, "backend");
    await mkdir(backendDir);
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        actions: { ping: { handler: "missing.py", runtime: "python" } },
      }),
    );

    const issues = await checkBackendManifestIntegrity(tempDir);
    expect(issues.some((i) => i.rule === "backend-handler-missing")).toBe(true);
  });

  it("warns when handler reads vault env without manifest keys", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-manifest-"));
    const backendDir = join(tempDir, "backend");
    await mkdir(backendDir);
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        actions: {
          "fetch-calls": { handler: "attention.py", runtime: "python" },
        },
      }),
    );
    await writeFile(
      join(backendDir, "attention.py"),
      `import os\napi_key = os.environ["RR_ATTENTION_API_KEY"]\n`,
    );

    const issues = await checkBackendManifestIntegrity(tempDir);
    expect(
      issues.some(
        (i) =>
          i.rule === "backend-vault-keys-undeclared" &&
          i.severity === "warning" &&
          i.message.includes("RR_ATTENTION_API_KEY"),
      ),
    ).toBe(true);
  });

  it("passes when manifest keys match handler env references", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-manifest-"));
    const backendDir = join(tempDir, "backend");
    await mkdir(backendDir);
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        actions: {
          "fetch-calls": {
            handler: "attention.py",
            runtime: "python",
            keys: ["RR_ATTENTION_API_KEY"],
          },
        },
      }),
    );
    await writeFile(
      join(backendDir, "attention.py"),
      `import os\napi_key = os.environ["RR_ATTENTION_API_KEY"]\n`,
    );

    const issues = await checkBackendManifestIntegrity(tempDir);
    expect(issues.some((i) => i.rule === "backend-vault-keys-undeclared")).toBe(
      false,
    );
  });

  it("warns when backend manifest keys are missing from requirements.json", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-manifest-"));
    const backendDir = join(tempDir, "backend");
    await mkdir(backendDir);
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        actions: {
          "fetch-calls": {
            handler: "attention.py",
            runtime: "python",
            keys: ["RR_ATTENTION_API_KEY"],
          },
        },
      }),
    );
    await writeFile(join(backendDir, "attention.py"), "print('ok')");

    const issues = await checkBackendManifestIntegrity(tempDir);
    expect(
      issues.some((i) => i.rule === "backend-keys-missing-from-requirements"),
    ).toBe(true);
  });
});
