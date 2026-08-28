import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkBackendManifestIntegrity,
  checkMiniAppBashPatterns,
  checkMiniAppBackendFetchPatterns,
  checkBackendHandlerPatterns,
  checkOrphanBackendHandlers,
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

describe("checkBackendHandlerPatterns", () => {
  it("errors on sys.stdin in python handlers", () => {
    const issues = checkBackendHandlerPatterns(
      "meeting_start.py",
      'body = json.load(sys.stdin)\n',
    );
    expect(issues.some((i) => i.rule === "backend-no-stdin" && i.severity === "error")).toBe(
      true,
    );
  });

  it("errors on APP_DB_PATH", () => {
    const issues = checkBackendHandlerPatterns(
      "migrate.py",
      'db = os.environ.get("APP_DB_PATH")\n',
    );
    expect(
      issues.some((i) => i.rule === "backend-no-app-db-path" && i.severity === "error"),
    ).toBe(true);
  });

  it("passes scaffold-style handler", () => {
    const issues = checkBackendHandlerPatterns(
      "ping.py",
      'params = json.loads(os.environ.get("PAPR_ACTION_PARAMS", "{}"))\n',
    );
    expect(issues).toHaveLength(0);
  });
});

describe("extractVaultEnvReferences", () => {
  it("ignores vault env names in comments (scaffold ping.py)", async () => {
    const { extractVaultEnvReferences } = await import(
      "../src/gateway/utils/miniAppBackendLint.js"
    );
    const { DEFAULT_BACKEND_PING_HANDLER } = await import(
      "../src/gateway/utils/appBackendScaffold.js"
    );
    expect(extractVaultEnvReferences(DEFAULT_BACKEND_PING_HANDLER).size).toBe(0);
  });

  it("still detects real vault env usage in code", async () => {
    const { extractVaultEnvReferences } = await import(
      "../src/gateway/utils/miniAppBackendLint.js"
    );
    const refs = extractVaultEnvReferences(
      `import os\n# not a real call: os.environ.get("COMMENT_KEY")\napi_key = os.environ.get("LIVE_API_KEY")\n`,
    );
    expect([...refs]).toEqual(["LIVE_API_KEY"]);
  });
});

describe("checkMiniAppBackendFetchPatterns", () => {
  it("warns when backend fetch body omits params wrapper", () => {
    const files = new Map<string, string>([
      [
        "utils/api.ts",
        `await fetch('/api/app/backend/meeting-start', {
          method: 'POST',
          body: JSON.stringify({ title: 'Daily' }),
        });`,
      ],
    ]);
    const issues = checkMiniAppBackendFetchPatterns(files);
    expect(
      issues.some(
        (i) => i.rule === "backend-fetch-params-wrapper" && i.severity === "warning",
      ),
    ).toBe(true);
  });

  it("passes when params wrapper is present", () => {
    const files = new Map<string, string>([
      [
        "utils/api.ts",
        `await fetch('/api/app/backend/ping', {
          method: 'POST',
          body: JSON.stringify({ params: { hello: 'world' } }),
        });`,
      ],
    ]);
    const issues = checkMiniAppBackendFetchPatterns(files);
    expect(issues).toHaveLength(0);
  });

  it("ignores JSON.stringify(variable) backend calls", () => {
    const files = new Map<string, string>([
      [
        "utils/api.ts",
        `function call(action, payload) {
          return fetch('/api/app/backend/' + action, {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        }`,
      ],
    ]);
    const issues = checkMiniAppBackendFetchPatterns(files);
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

  it("errors when handler reads sys.stdin", async () => {
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
    await writeFile(
      join(backendDir, "ping.py"),
      "import json, sys\nbody = json.load(sys.stdin)\n",
    );

    const issues = await checkBackendManifestIntegrity(tempDir);
    expect(issues.some((i) => i.rule === "backend-no-stdin")).toBe(true);
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

  it("warns when manifest lists platform-injected PAPR_CALLER keys", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-manifest-"));
    const backendDir = join(tempDir, "backend");
    await mkdir(backendDir);
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        actions: {
          ping: {
            handler: "ping.py",
            runtime: "python",
            keys: ["PAPR_CALLER_USER_ID", "PAPR_CALLER_EMAIL"],
          },
        },
      }),
    );
    await writeFile(join(backendDir, "ping.py"), "print('ok')");

    const issues = await checkBackendManifestIntegrity(tempDir);
    expect(
      issues.some((i) => i.rule === "backend-keys-platform-injected"),
    ).toBe(true);
  });
});

describe("checkOrphanBackendHandlers", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("errors when migrate.py exists but is not in manifest", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-orphan-"));
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
    await writeFile(join(backendDir, "migrate.py"), "print('migrate')");

    const issues = await checkOrphanBackendHandlers(tempDir);
    expect(
      issues.some(
        (i) => i.rule === "backend-handler-orphan" && i.message.includes("migrate.py"),
      ),
    ).toBe(true);
  });

  it("ignores papr_db.py helper copied by scaffold", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-orphan-"));
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
    await writeFile(join(backendDir, "papr_db.py"), "# shared helper\n");

    const issues = await checkOrphanBackendHandlers(tempDir);
    expect(
      issues.filter((i) => i.rule === "backend-handler-orphan"),
    ).toHaveLength(0);
  });
});
