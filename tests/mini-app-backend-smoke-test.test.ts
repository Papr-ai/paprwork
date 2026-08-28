import { rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBackendActionSmokeTest } from "../src/gateway/utils/miniAppBackendSmokeTest.js";
import {
  DEFAULT_BACKEND_MANIFEST,
  DEFAULT_BACKEND_PING_HANDLER,
} from "../src/gateway/utils/appBackendScaffold.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("checkBackendActionSmokeTest", () => {
  const workspace = useIsolatedPaprWorkspace("mini-app-backend-smoke");

  let tempRoot: string;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("passes scaffolded ping action", async () => {
    tempRoot = join(workspace.paprHome, "apps", "smoke-app-id", "backend");
    const appId = "smoke-app-id";
    await mkdir(tempRoot, { recursive: true });
    await writeFile(
      join(tempRoot, "manifest.json"),
      JSON.stringify(DEFAULT_BACKEND_MANIFEST, null, 2),
    );
    await writeFile(join(tempRoot, "ping.py"), DEFAULT_BACKEND_PING_HANDLER);

    const issues = await checkBackendActionSmokeTest(appId);
    expect(issues).toHaveLength(0);
  });

  it("errors when handler reads stdin", async () => {
    tempRoot = join(workspace.paprHome, "apps", "smoke-bad-id", "backend");
    const appId = "smoke-bad-id";
    await mkdir(tempRoot, { recursive: true });
    await writeFile(
      join(tempRoot, "manifest.json"),
      JSON.stringify(DEFAULT_BACKEND_MANIFEST, null, 2),
    );
    await writeFile(
      join(tempRoot, "ping.py"),
      `import json, sys\nbody = json.load(sys.stdin)\nprint(json.dumps({"ok": True}))\n`,
    );

    const issues = await checkBackendActionSmokeTest(appId);
    expect(issues.some((i) => i.rule === "backend-smoke-test" && i.severity === "error")).toBe(
      true,
    );
  });

  it("skips when manifest is missing", async () => {
    const issues = await checkBackendActionSmokeTest("no-backend-app");
    expect(issues).toHaveLength(0);
  });
});
