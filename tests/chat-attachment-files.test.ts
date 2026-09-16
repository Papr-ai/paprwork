/**
 * A drop that attaches nothing must say why.
 *
 * The bug these cover: every drop surface read the drop through a filter that
 * silently discarded anything outside an allowlist, then returned early on the
 * empty result without a word. An unsupported file and a broken feature were
 * therefore indistinguishable from the user's side, at three separate call
 * sites plus paste — and the one place that owns an error surface never heard
 * about the rejection at all.
 *
 * The distinction that has to survive is *nothing was dropped* versus *what was
 * dropped could not be attached*. The first must leave the event alone, or a
 * plain text paste stops working; the second must be reported.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyAttachmentFiles,
  describeRejectedAttachments,
  isAbsoluteFilePath,
  isSupportedAttachmentFile,
  readIncomingFiles,
} from "../ui/utils/chatAttachmentFiles";
import { getElectronFilePath } from "../ui/utils/fileContextArtifact";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

/** Strip comments so an assertion cannot be satisfied by prose describing it. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function sliceFunction(source: string, declaration: string, end: string): string {
  const start = source.indexOf(declaration);
  expect(start, `missing declaration: ${declaration}`).toBeGreaterThan(-1);
  const stop = source.indexOf(end, start);
  expect(stop, `missing end anchor: ${end}`).toBeGreaterThan(start);
  return source.slice(start, stop);
}

function asTransfer(init: {
  files?: File[];
  items?: unknown[];
}): DataTransfer {
  return {
    files: init.files ?? [],
    items: init.items ?? [],
    types: (init.files?.length ?? 0) > 0 ? ["Files"] : [],
  } as unknown as DataTransfer;
}

describe("chatAttachmentFiles", () => {
  it("detects absolute paths on unix and windows", () => {
    expect(isAbsoluteFilePath("/Users/test/image.png")).toBe(true);
    expect(isAbsoluteFilePath("C:\\Users\\test\\image.png")).toBe(true);
    expect(isAbsoluteFilePath("image.png")).toBe(false);
  });

  it("accepts images and pdfs", () => {
    expect(
      isSupportedAttachmentFile(
        new File(["x"], "photo.png", { type: "image/png" }),
      ),
    ).toBe(true);
    expect(
      isSupportedAttachmentFile(
        new File(["x"], "doc.pdf", { type: "application/pdf" }),
      ),
    ).toBe(true);
    expect(
      isSupportedAttachmentFile(
        new File(["x"], "notes.txt", { type: "text/plain" }),
      ),
    ).toBe(true);
  });

  it("accepts the data and office formats users actually drop", () => {
    for (const name of [
      "rows.csv",
      "book.xlsx",
      "brief.docx",
      "deck.pptx",
      "notebook.ipynb",
      "archive.zip",
      "clip.mov",
    ]) {
      expect(
        isSupportedAttachmentFile(new File(["x"], name, { type: "" })),
        `${name} should be attachable`,
      ).toBe(true);
    }
  });

  it("extracts files from dataTransfer items when files list is empty", () => {
    const png = new File(["x"], "shot.png", { type: "image/png" });
    const items = [{ kind: "file", type: "image/png", getAsFile: () => png }];

    expect(readIncomingFiles(asTransfer({ items }))).toEqual([png]);
  });

  it("reads unsupported files rather than discarding them", () => {
    // The whole point of the change: the reader must hand back the file it
    // cannot attach, because that is the only way anything downstream can name
    // it. Filtering here is what made the rejection silent.
    const odd = new File(["x"], "model.sketch", { type: "" });

    expect(readIncomingFiles(asTransfer({ files: [odd] }))).toEqual([odd]);
    expect(classifyAttachmentFiles([odd])).toEqual({
      accepted: [],
      rejected: [odd],
    });
  });

  it("reports nothing for a drop with no files, so a text paste is left alone", () => {
    const textOnly = asTransfer({
      items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
    });

    expect(readIncomingFiles(textOnly)).toEqual([]);
    expect(describeRejectedAttachments([])).toBeNull();
  });

  it("splits a mixed drop instead of failing the whole thing", () => {
    const png = new File(["x"], "photo.png", { type: "image/png" });
    const odd = new File(["x"], "model.sketch", { type: "" });

    const { accepted, rejected } = classifyAttachmentFiles([png, odd]);
    expect(accepted).toEqual([png]);
    expect(rejected).toEqual([odd]);
  });

  it("names the rejected files, and does not enumerate a long list", () => {
    const one = describeRejectedAttachments([
      new File(["x"], "model.sketch", { type: "" }),
    ]);
    expect(one).toContain("model.sketch");

    const many = describeRejectedAttachments(
      ["a.sketch", "b.sketch", "c.sketch", "d.sketch", "e.sketch"].map(
        (n) => new File(["x"], n, { type: "" }),
      ),
    );
    expect(many).toContain("a.sketch");
    expect(many).toContain("and 2 more");
    expect(many).not.toContain("e.sketch");
  });
});

describe("getElectronFilePath", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  function withElectronApi(api: unknown): void {
    (globalThis as { window?: unknown }).window = { electronAPI: api };
  }

  it("asks webUtils first, since Electron 32 removed File.path", () => {
    withElectronApi({
      files: { getPathForFile: () => "/Users/test/Downloads/report.pdf" },
    });

    const file = new File(["x"], "report.pdf", { type: "application/pdf" });
    expect(getElectronFilePath(file)).toBe("/Users/test/Downloads/report.pdf");
  });

  it("falls back to the file name when the file has no disk backing", () => {
    // A pasted blob is not on disk, so webUtils returns "" and the copy path
    // has to run. Returning "" here instead of a name would lose the label.
    withElectronApi({ files: { getPathForFile: () => "" } });

    const pasted = new File(["x"], "pasted-image.png", { type: "image/png" });
    expect(getElectronFilePath(pasted)).toBe("pasted-image.png");
  });

  it("still honours a legacy File.path if a host populates it", () => {
    withElectronApi({ files: { getPathForFile: () => "" } });

    const file = Object.assign(new File(["x"], "old.png", { type: "image/png" }), {
      path: "/legacy/old.png",
    });
    expect(getElectronFilePath(file)).toBe("/legacy/old.png");
  });
});

describe("drop surfaces route rejections to the one place that can report them", () => {
  it("has no silent filtering reader left anywhere", () => {
    // Pinned by name: reintroducing a reader that filters would restore the
    // original defect at whichever call site adopted it, invisibly.
    for (const rel of [
      "ui/utils/chatAttachmentFiles.ts",
      "ui/components/Chat/ChatContainer.tsx",
      "ui/components/Chat/MessageList.tsx",
      "ui/components/Chat/InputBar.tsx",
    ]) {
      expect(
        stripComments(readSource(rel)),
        `${rel} still references the filtering reader`,
      ).not.toContain("extractFilesFromDataTransfer");
    }
  });

  it("reads unfiltered at every drop surface", () => {
    for (const rel of [
      "ui/components/Chat/ChatContainer.tsx",
      "ui/components/Chat/MessageList.tsx",
      "ui/components/Chat/InputBar.tsx",
    ]) {
      expect(
        stripComments(readSource(rel)),
        `${rel} should read the drop unfiltered`,
      ).toContain("readIncomingFiles(");
    }
  });

  it("classifies in exactly one place — the component that owns the error surface", () => {
    const inputBar = stripComments(readSource("ui/components/Chat/InputBar.tsx"));
    expect(inputBar).toContain("classifyAttachmentFiles(");
    expect(inputBar).toContain("describeRejectedAttachments(");
    expect(inputBar).toContain("setAttachmentError(");

    // The other surfaces must not classify: two copies of the policy would
    // drift, and only this one can show the result.
    for (const rel of [
      "ui/components/Chat/ChatContainer.tsx",
      "ui/components/Chat/MessageList.tsx",
    ]) {
      expect(stripComments(readSource(rel))).not.toContain(
        "classifyAttachmentFiles",
      );
    }
  });

  it("reports before returning when nothing in the drop was attachable", () => {
    // The original defect in one line: this branch returned early on an empty
    // result. Reporting has to happen *before* the return, or the drop is
    // silent again for exactly the case the user hits.
    const body = sliceFunction(
      stripComments(readSource("ui/components/Chat/InputBar.tsx")),
      "const appendFileArtifacts",
      "const handleFileDragOver",
    );

    const emptyBranch = body.indexOf("if (accepted.length === 0)");
    expect(emptyBranch, "missing empty-accepted branch").toBeGreaterThan(-1);
    const returnAt = body.indexOf("return;", emptyBranch);
    expect(returnAt).toBeGreaterThan(emptyBranch);
    expect(body.slice(emptyBranch, returnAt)).toContain("setAttachmentError(");
  });

  it("catches a throw on the way in rather than leaving an unhandled rejection", () => {
    // This was try/finally with no catch, so a base64 encode that ran out of
    // stack on a large file, or an IPC rejection, ended the drop with no error
    // shown and nothing logged.
    const body = sliceFunction(
      stripComments(readSource("ui/components/Chat/InputBar.tsx")),
      "const appendFileArtifacts",
      "const handleFileDragOver",
    );

    const catchAt = body.indexOf("} catch (");
    const finallyAt = body.indexOf("} finally {");
    expect(catchAt, "appendFileArtifacts must catch").toBeGreaterThan(-1);
    expect(finallyAt).toBeGreaterThan(catchAt);
    expect(body.slice(catchAt, finallyAt)).toContain("setAttachmentError(");
  });

  it("exposes a real file path through the preload, not the removed File.path", () => {
    const preload = stripComments(readSource("src/electron/preload.cjs"));
    expect(preload).toContain("webUtils");
    expect(preload).toContain("getPathForFile");
  });
});
