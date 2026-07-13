import { describe, expect, it } from "vitest";
import {
  extractFilesFromDataTransfer,
  isAbsoluteFilePath,
  isSupportedAttachmentFile,
} from "../ui/utils/chatAttachmentFiles";

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

  it("extracts files from dataTransfer items when files list is empty", () => {
    const png = new File(["x"], "shot.png", { type: "image/png" });
    const items = [
      {
        kind: "file",
        type: "image/png",
        getAsFile: () => png,
      },
    ];
    const dataTransfer = {
      files: [],
      items,
      types: ["Files"],
    } as unknown as DataTransfer;

    expect(extractFilesFromDataTransfer(dataTransfer)).toEqual([png]);
  });
});
