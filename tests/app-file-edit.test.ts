import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  applyExactStringReplacement,
  countOccurrences,
  getOccurrenceLineNumbers,
  replaceOccurrence,
} from "../src/core/utils/exactStringReplace.js";

describe("exactStringReplace", () => {
  it("counts occurrences", () => {
    expect(countOccurrences("a-b-a-b", "a")).toBe(2);
    expect(countOccurrences("hello", "z")).toBe(0);
  });

  it("reports line numbers for ambiguous matches", () => {
    const content = "line1\nmatch\nline3\nmatch\n";
    expect(getOccurrenceLineNumbers(content, "match")).toEqual([2, 4]);
  });

  it("replaces a specific occurrence", () => {
    const content = "foo bar foo baz";
    expect(replaceOccurrence(content, "foo", "qux", 2)).toBe("foo bar qux baz");
  });

  it("errors when oldString appears multiple times without occurrence", () => {
    expect(() =>
      applyExactStringReplacement({
        content: '<div class="section-body"></div><div class="section-body"></div>',
        filename: "render.js",
        oldString: 'class="section-body"',
        newString: 'class="section-body brief"',
        linesToolName: "edit_app_file_lines",
      }),
    ).toThrow(/appears 2 times/);
  });

  it("replaces chosen occurrence and verifies result", () => {
    const content = "alpha beta alpha gamma";
    const result = applyExactStringReplacement({
      content,
      filename: "test.js",
      oldString: "alpha",
      newString: "omega",
      occurrence: 2,
    });
    expect(result.newContent).toBe("alpha beta omega gamma");
    expect(result.occurrencesFound).toBe(2);
    expect(result.occurrenceReplaced).toBe(2);
  });
});

describe("AppService.updateAppFile", () => {
  let tmpDir: string;
  let origHome: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-app-edit-test-"));
    origHome = os.homedir;
    (os as { homedir: () => string }).homedir = () => tmpDir;
  });

  afterEach(async () => {
    (os as { homedir: () => string }).homedir = () => origHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("serializes concurrent edits to the same file", async () => {
    const { AppService } = await import(
      "../src/gateway/services/AppService.js"
    );
    const service = new AppService();
    await service.initialize();

    const app = await service.createApp("Concurrent Edit App", "test", [
      { filename: "index.html", content: "<html><body></body></html>" },
      { filename: "counter.js", content: "value=0;" },
    ]);

    await Promise.all([
      service.updateAppFile(app.id, "counter.js", (content) =>
        content.replace("value=0", "value=1"),
      ),
      service.updateAppFile(app.id, "counter.js", (content) =>
        content.replace("value=1", "value=2"),
      ),
    ]);

    const finalContent = await service.readAppFile(app.id, "counter.js");
    expect(finalContent).toBe("value=2;");
  });
});
