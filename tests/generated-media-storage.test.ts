import { describe, expect, it } from "vitest";
import { resolveGeneratedMediaFileName } from "../src/gateway/services/mediaGeneration/storage.js";

describe("resolveGeneratedMediaFileName", () => {
  const defaults = {
    suggestedExtension: "jpg",
    modelId: "gemini-3.1-flash-image",
    sha256Prefix: "abcdef1234567890",
  };

  it("generates a hashed default name when fileName is omitted", () => {
    expect(resolveGeneratedMediaFileName(defaults)).toBe(
      "gemini-3.1-flash-image-abcdef12.jpg",
    );
  });

  it("appends suggested extension when fileName has no extension", () => {
    expect(
      resolveGeneratedMediaFileName({
        ...defaults,
        fileName: "ocean-city-clouds",
      }),
    ).toBe("ocean-city-clouds.jpg");
  });

  it("preserves an explicit extension", () => {
    expect(
      resolveGeneratedMediaFileName({
        ...defaults,
        fileName: "hero.png",
      }),
    ).toBe("hero.png");
  });

  it("sanitizes stems and normalizes jpeg to jpg", () => {
    expect(
      resolveGeneratedMediaFileName({
        ...defaults,
        fileName: "Ocean City Clouds.JPEG",
      }),
    ).toBe("ocean-city-clouds.jpg");
  });

  it("uses video extension for mp4 outputs", () => {
    expect(
      resolveGeneratedMediaFileName({
        ...defaults,
        suggestedExtension: "mp4",
        fileName: "beach-waves",
      }),
    ).toBe("beach-waves.mp4");
  });
});
