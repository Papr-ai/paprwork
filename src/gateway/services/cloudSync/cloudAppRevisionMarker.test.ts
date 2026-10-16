import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { distBundleRevisionHash, PAPR_APP_CLOUD_REVISION_PATH, writeAppCloudRevisionMarker } from "./cloudAppRevisionMarker.js";

let app: string;
const marker = () => readFileSync(path.join(app, PAPR_APP_CLOUD_REVISION_PATH), "utf8").trim();
const put = (rel: string, body: string) => {
  mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
  writeFileSync(path.join(app, rel), body);
};
beforeEach(() => { app = mkdtempSync(path.join(tmpdir(), "rev-")); put("dist/app.js", "console.info(1)"); });
afterEach(() => rmSync(app, { recursive: true, force: true }));

describe("writeAppCloudRevisionMarker", () => {
  it("is the plain app.js hash for an app without Claude cards (no cache bust for them)", () => {
    writeAppCloudRevisionMarker(app);
    expect(marker()).toBe(distBundleRevisionHash("console.info(1)"));
  });

  it("moves when only a Claude card changes, so the host stops serving the old card", () => {
    put("dist/cards/library.html", "<p>old</p>");
    writeAppCloudRevisionMarker(app);
    const before = marker();
    expect(before).not.toBe(distBundleRevisionHash("console.info(1)"));
    put("dist/cards/library.html", "<p>new</p>");
    writeAppCloudRevisionMarker(app);
    expect(marker()).not.toBe(before);
  });

  it("is stable when nothing changed", () => {
    put("dist/cards/library.html", "<p>x</p>");
    put("dist/cards/cards.json", "{}");
    writeAppCloudRevisionMarker(app);
    const a = marker();
    writeAppCloudRevisionMarker(app);
    expect(marker()).toBe(a);
  });

  it("moves when only requirements.json changes, so the host's credential gate sees the edit", () => {
    put("requirements.json", '{"requirements":[{"name":"K","required":true}]}');
    writeAppCloudRevisionMarker(app);
    const before = marker();
    expect(before).not.toBe(distBundleRevisionHash("console.info(1)"));
    put("requirements.json", '{"requirements":[{"name":"K","required":false}]}');
    writeAppCloudRevisionMarker(app);
    expect(marker()).not.toBe(before);
  });
});
