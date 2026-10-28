import { describe, expect, it } from "vitest";
import { getMediaModelById, resolveMediaModel } from "../../src/gateway/services/mediaGeneration/models.js";
import { buildOmniPrompt } from "../../src/gateway/services/mediaGeneration/omniVideo.js";

describe("Gemini Omni video", () => {
  it("retired Veo ids resolve to Gemini Omni Flash", () => {
    for (const id of ["veo-3.1-generate-preview", "veo-3.1-fast-generate-preview"]) {
      expect(getMediaModelById(id)?.id).toBe("gemini-omni-1.1-flash");
    }
    const resolved = resolveMediaModel("veo-3.1-generate-preview", { googleApiKey: "k" });
    expect(resolved.model?.apiStyle).toBe("gemini_interactions_video");
    expect(resolved.model?.remoteModel).toBe("gemini-omni-1.1-flash");
  });

  it("tags images in input order: first frame, last frame, then references", () => {
    expect(buildOmniPrompt({ prompt: "walk", hasFirstFrame: true, hasLastFrame: true, referenceCount: 2 })).toBe(
      "[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2] [# References <IMAGE_REF_0>@Image3 <IMAGE_REF_1>@Image4] walk",
    );
    expect(buildOmniPrompt({ prompt: "walk", hasFirstFrame: true, hasLastFrame: false, referenceCount: 0 })).toBe(
      "[# Sources <FIRST_FRAME>@Image1] walk",
    );
    expect(buildOmniPrompt({ prompt: "walk", hasFirstFrame: false, hasLastFrame: false, referenceCount: 1 })).toBe(
      "[# References <IMAGE_REF_0>@Image1] walk",
    );
    expect(buildOmniPrompt({ prompt: "walk", hasFirstFrame: false, hasLastFrame: false, referenceCount: 0 })).toBe("walk");
  });
});
