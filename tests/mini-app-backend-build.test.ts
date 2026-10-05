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

  it("leaves bundle.json byte-identical when handlers are unchanged (no publish loop)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-backend-build-"));
    const backendDir = join(tempDir, "backend");
    await mkdir(backendDir);
    await writeFile(join(backendDir, "manifest.json"), JSON.stringify(DEFAULT_BACKEND_MANIFEST, null, 2));
    await writeFile(join(backendDir, "ping.py"), DEFAULT_BACKEND_PING_HANDLER);

    await buildAppBackendBundle(tempDir);
    const { readFile } = await import("fs/promises");
    const before = await readFile(join(backendDir, "bundle.json"), "utf8");
    await new Promise((r) => setTimeout(r, 5));
    const again = await buildAppBackendBundle(tempDir);
    // Regression: a new builtAt on every build made each publish dirty the app again.
    expect(again.wroteBundle).toBe(false);
    expect(await readFile(join(backendDir, "bundle.json"), "utf8")).toBe(before);

    await writeFile(join(backendDir, "ping.py"), DEFAULT_BACKEND_PING_HANDLER + "\n# changed\n");
    expect((await buildAppBackendBundle(tempDir)).wroteBundle).toBe(true);
  });
});
