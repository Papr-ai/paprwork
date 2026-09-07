import { describe, expect, it } from "vitest";
import {
  extractGeneratedMediaPreviewData,
  formatGeneratedMediaSize,
  parseGeneratedMediaGalleryItem,
  resolveGeneratedMediaFileName,
} from "../ui/utils/generatedMediaPreview.js";

describe("generatedMediaPreview", () => {
  it("extracts image artifact fields from tool result envelope", () => {
    const data = extractGeneratedMediaPreviewData({
      success: true,
      data: {
        kind: "image",
        localPath: "/Users/me/Papr/data/generated-media/hero.png",
        fileName: "hero.png",
        mimeType: "image/png",
        modelId: "gemini-3.1-flash-image",
        sizeBytes: 2048,
      },
    });

    expect(data?.kind).toBe("image");
    expect(data?.localPath).toContain("hero.png");
    expect(data?.modelId).toBe("gemini-3.1-flash-image");
  });

  it("extracts video artifact with app file registration", () => {
    const data = extractGeneratedMediaPreviewData({
      success: true,
      data: {
        kind: "video",
        localPath: "/Users/me/Papr/Jobs/job-1/clip.mp4",
        appId: "11111111-1111-1111-1111-111111111111",
        appFileId: "22222222-2222-2222-2222-222222222222",
        mimeType: "video/mp4",
      },
    });

    expect(data?.kind).toBe("video");
    expect(data?.appId).toBe("11111111-1111-1111-1111-111111111111");
    expect(data?.appFileId).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("parses gallery items with prompt from tool args", () => {
    const item = parseGeneratedMediaGalleryItem({
      toolName: "generate_media",
      status: "success",
      args: { prompt: "A sunset over the ocean" },
      fallbackId: "tool-1",
      result: {
        success: true,
        data: {
          kind: "image",
          localPath: "/tmp/hero.png",
          fileName: "hero.png",
          mimeType: "image/png",
        },
      },
    });

    expect(item?.prompt).toBe("A sunset over the ocean");
    expect(item?.id).toBe("/tmp/hero.png");
  });

  it("parses gallery items with appFileId-first tool result shape", () => {
    const item = parseGeneratedMediaGalleryItem({
      toolName: "generate_media",
      status: "success",
      fallbackId: "tool-2",
      result: {
        success: true,
        data: {
          appFileId: "0e12fb4c-d394-493d-929c-849b44a3c7fa",
          appId: "a3b51c4f-186a-4106-8ab3-08b9cf5ed12a",
          fileName: "slide-hero-bg.png",
          kind: "image",
          localPath: "/tmp/generated-media/slide-hero-bg.png",
          mimeType: "image/png",
          nextStep: "Store appFileId in SQLite",
        },
      },
    });

    expect(item?.appFileId).toBe("0e12fb4c-d394-493d-929c-849b44a3c7fa");
    expect(item?.fileName).toBe("slide-hero-bg.png");
  });

  it("formats byte sizes for preview meta", () => {
    expect(formatGeneratedMediaSize(512)).toBe("512 B");
    expect(formatGeneratedMediaSize(2048)).toBe("2.0 KB");
    expect(formatGeneratedMediaSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("appends mime extension when fileName lacks one", () => {
    expect(
      resolveGeneratedMediaFileName({
        kind: "image",
        fileName: "ocean-city-clouds",
        mimeType: "image/png",
        localPath: "/Users/me/Papr/data/generated-media/ocean-city-clouds",
      }),
    ).toBe("ocean-city-clouds.png");
  });

  it("keeps explicit file extensions", () => {
    expect(
      resolveGeneratedMediaFileName({
        kind: "image",
        fileName: "hero.webp",
        mimeType: "image/png",
      }),
    ).toBe("hero.webp");
  });
});
