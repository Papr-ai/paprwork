import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { distBundleRevisionHash, distRevisionHash } from "./cloudAppRevisionMarker.js";

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rev-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

describe("distRevisionHash", () => {
  it("matches the bundle-only hash when the app has no cards", () => {
    expect(distRevisionHash(app({ "dist/app.js": "x" }))).toBe(distBundleRevisionHash("x"));
  });
  it("changes when only a card changes", () => {
    const a = distRevisionHash(app({ "dist/app.js": "x", "dist/cards/library.html": "<p>old</p>" }));
    const b = distRevisionHash(app({ "dist/app.js": "x", "dist/cards/library.html": "<p>new</p>" }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(distBundleRevisionHash("x"));
  });
  it("is null without a bundle", () => {
    expect(distRevisionHash(app({}))).toBeNull();
  });
});
