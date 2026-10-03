/**
 * Regression: re-writing an identical allowlist after publish bumped the file's
 * mtime, and mtime-based sync change detection flipped the app to
 * "Unpublished changes" right after the user published.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SHARE_PEOPLE_ALLOWLIST_REPO_PATH,
  writeSharePeopleAllowlistRepoFile,
} from "../src/gateway/services/appRuntime/sharePeopleAllowlistRepoArtifact.js";

describe("writeSharePeopleAllowlistRepoFile", () => {
  let appDir: string;
  beforeEach(() => {
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), "allowlist-"));
  });
  afterEach(() => fs.rmSync(appDir, { recursive: true, force: true }));

  it("does not touch the file when the content is unchanged", async () => {
    const target = path.join(appDir, SHARE_PEOPLE_ALLOWLIST_REPO_PATH);
    await writeSharePeopleAllowlistRepoFile(appDir, { allowedEmails: ["a@b.co"] });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(target, past, past);
    const before = fs.statSync(target).mtimeMs;

    await writeSharePeopleAllowlistRepoFile(appDir, { allowedEmails: ["a@b.co"] });
    expect(fs.statSync(target).mtimeMs).toBe(before);

    await writeSharePeopleAllowlistRepoFile(appDir, { allowedEmails: ["c@d.co"] });
    expect(fs.statSync(target).mtimeMs).not.toBe(before);
    expect(fs.readFileSync(target, "utf8")).toContain("c@d.co");
  });
});
