import { describe, expect, it } from "vitest";
import { artifactsToMessageAttachments, isImageAttachment } from "../ui/utils/messageAttachments";
import type { Artifact } from "../ui/stores/artifactsStore";

describe("messageAttachments", () => {
  it("maps file artifacts to message attachments", () => {
    const artifacts: Artifact[] = [
      {
        id: "file-1",
        title: "report.pdf",
        type: "file",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        metadata: {
          filePath: "/tmp/report.pdf",
          fileType: "application/pdf",
        },
      },
    ];

    const result = artifactsToMessageAttachments(artifacts);
    expect(result).toEqual([
      {
        id: "file-1",
        name: "report.pdf",
        kind: "file",
        mimeType: "application/pdf",
        filePath: "/tmp/report.pdf",
      },
    ]);
  });

  it("detects image attachments", () => {
    expect(
      isImageAttachment({
        id: "1",
        name: "photo.png",
        kind: "file",
        mimeType: "image/png",
      }),
    ).toBe(true);
  });
});
