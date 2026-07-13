import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAppBackendBundle } from "../src/gateway/utils/miniAppBackendBuild.js";
import { DEFAULT_BACKEND_MANIFEST, DEFAULT_BACKEND_PING_HANDLER } from "../src/gateway/utils/appBackendScaffold.js";

describe("buildAppBackendBundle", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips when no backend manifest", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-backend-build-"));
    const result = await buildAppBackendBundle(tempDir);
    expect(result.success).toBe(true);
    expect(result.wroteBundle).toBe(false);
  });

  it("writes bundle.json with handler hashes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-backend-build-"));
    const backendDir = join(tempDir, "backend");
    await mkdir(backendDir);
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify(DEFAULT_BACKEND_MANIFEST, null, 2),
    );
    await writeFile(join(backendDir, "ping.py"), DEFAULT_BACKEND_PING_HANDLER);

    const result = await buildAppBackendBundle(tempDir);
    expect(result.success).toBe(true);
    expect(result.wroteBundle).toBe(true);
    expect(result.bundle?.actions.ping?.handler).toBe("ping.py");
    expect(result.bundle?.actions.ping?.sha256).toHaveLength(64);
  });
});
