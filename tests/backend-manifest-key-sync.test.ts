import { mkdtemp, readFile, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { syncBackendManifestVaultKeys } from "../src/gateway/utils/backendManifestKeySync.js";
import { checkBackendManifestIntegrity } from "../src/gateway/utils/miniAppBackendLint.js";

describe("syncBackendManifestVaultKeys", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("adds detected vault env names to the matching manifest action", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-manifest-sync-"));
    const backendDir = join(tempDir, "backend");
    await mkdir(backendDir);
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        actions: {
          ping: { handler: "ping.py", runtime: "python" },
        },
      }),
    );
    const handlerSource = `import os\napi_key = os.environ["RR_ATTENTION_API_KEY"]\n`;

    const result = await syncBackendManifestVaultKeys(
      tempDir,
      "backend/ping.py",
      handlerSource,
    );

    expect(result.updated).toBe(true);
    expect(result.actionNames).toEqual(["ping"]);
    expect(result.addedKeys).toEqual(["RR_ATTENTION_API_KEY"]);

    const manifest = JSON.parse(
      await readFile(join(backendDir, "manifest.json"), "utf8"),
    ) as {
      actions: { ping: { keys: string[] } };
    };
    expect(manifest.actions.ping.keys).toEqual(["RR_ATTENTION_API_KEY"]);
  });

  it("is idempotent when keys are already declared", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-manifest-sync-"));
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
            keys: ["RR_ATTENTION_API_KEY"],
          },
        },
      }),
    );
    const handlerSource = `import os\napi_key = os.environ["RR_ATTENTION_API_KEY"]\n`;

    const result = await syncBackendManifestVaultKeys(
      tempDir,
      "backend/ping.py",
      handlerSource,
    );

    expect(result.updated).toBe(false);
    expect(result.addedKeys).toEqual([]);
  });

  it("ignores non-handler backend files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-manifest-sync-"));
    const backendDir = join(tempDir, "backend");
    await mkdir(backendDir);
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        actions: {
          ping: { handler: "ping.py", runtime: "python" },
        },
      }),
    );

    const result = await syncBackendManifestVaultKeys(
      tempDir,
      "backend/manifest.json",
      '{"keys":["RR_ATTENTION_API_KEY"]}',
    );

    expect(result.updated).toBe(false);
  });

  it("clears undeclared-key lint warnings after sync", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-manifest-sync-"));
    const backendDir = join(tempDir, "backend");
    await mkdir(backendDir);
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        actions: {
          ping: { handler: "ping.py", runtime: "python" },
        },
      }),
    );
    const handlerSource = `import os\napi_key = os.environ["RR_ATTENTION_API_KEY"]\n`;
    await writeFile(join(backendDir, "ping.py"), handlerSource);

    const before = await checkBackendManifestIntegrity(tempDir);
    expect(
      before.some((issue) => issue.rule === "backend-vault-keys-undeclared"),
    ).toBe(true);

    await syncBackendManifestVaultKeys(tempDir, "backend/ping.py", handlerSource);

    const after = await checkBackendManifestIntegrity(tempDir);
    expect(
      after.some((issue) => issue.rule === "backend-vault-keys-undeclared"),
    ).toBe(false);
  });
});
