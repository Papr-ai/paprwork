import { describe, it, expect, afterEach } from "vitest";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { buildMiniApp, MiniAppDistBuildError } from "../src/gateway/utils/miniAppBuild.js";
import { isPublishedPageRequest } from "../src/gateway/services/appRuntime/CloudAppHostService.js";

const dirs: string[] = [];
async function tmpApp(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-fix-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("dist/ for every TypeScript entry", () => {
  it("bundles an app.ts with no imports", async () => {
    const dir = await tmpApp({ "index.html": "<html></html>", "app.ts": "document.title = 'probe';" });
    const result = await buildMiniApp(dir);
    expect(result.legacy).toBe(false);
    expect(result.success).toBe(true);
    expect(await fs.readFile(path.join(dir, "dist", "app.js"), "utf8")).toContain("probe");
  });

  it("leaves plain multi-script apps unbundled", async () => {
    const dir = await tmpApp({ "index.html": "<html></html>", "app.js": "1" });
    expect((await buildMiniApp(dir)).legacy).toBe(true);
  });

  it("MiniAppDistBuildError names the file", () => {
    const err = new MiniAppDistBuildError("abc", [
      { file: "app.ts", line: 3, message: "Unexpected }", severity: "error" },
    ]);
    expect(err.message).toContain("app.ts:3 Unexpected }");
  });
});

describe("published app access denial", () => {
  it("treats only navigations as pages", () => {
    expect(isPublishedPageRequest("index.html")).toBe(true);
    expect(isPublishedPageRequest("settings")).toBe(true);
    expect(isPublishedPageRequest("app.ts")).toBe(false);
    expect(isPublishedPageRequest("dist/app.js")).toBe(false);
    expect(isPublishedPageRequest("styles.css")).toBe(false);
  });
});
