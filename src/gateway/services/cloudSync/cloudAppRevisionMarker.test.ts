import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appCloudRevisionHash, distBundleRevisionHash } from "./cloudAppRevisionMarker.js";

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rev-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe("appCloudRevisionHash", () => {
  it("is the plain app.js hash for apps without cards or requirements", () => {
    expect(appCloudRevisionHash(app({}), "js")).toBe(distBundleRevisionHash("js"));
  });

  it("moves when only requirements.json changes", () => {
    const a = appCloudRevisionHash(app({ "requirements.json": '{"required":true}' }), "js");
    const b = appCloudRevisionHash(app({ "requirements.json": '{"required":false}' }), "js");
    expect(a).not.toBe(b);
  });

  it("moves when only a card changes", () => {
    const a = appCloudRevisionHash(app({ "dist/cards/cards.json": "1" }), "js");
    const b = appCloudRevisionHash(app({ "dist/cards/cards.json": "2" }), "js");
    expect(a).not.toBe(b);
  });
});
