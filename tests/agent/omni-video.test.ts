import { describe, expect, it } from "vitest";
import { omniRolePrefix, omniVideoOutput } from "../../src/gateway/services/mediaGeneration/omniVideo.js";
import { getMediaModelById, resolveMediaModel } from "../../src/gateway/services/mediaGeneration/models.js";

describe("Gemini Omni video", () => {
  it("binds first, last and reference images to their roles in order", () => {
    expect(omniRolePrefix({ first: true, last: true, refs: 0 })).toBe("[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2]");
    expect(omniRolePrefix({ first: true, last: false, refs: 2 })).toBe("[# Sources <FIRST_FRAME>@Image1] [# References <IMAGE_REF_0>@Image2 <IMAGE_REF_1>@Image3]");
    expect(omniRolePrefix({ first: false, last: false, refs: 0 })).toBe("");
  });

  it("finds the video in the REST steps array", () => {
    const out = omniVideoOutput({ steps: [{ type: "thought", content: [] }, { type: "model_output", content: [{ type: "video", mime_type: "video/mp4", uri: "https://x/files/a:download" }] }] });
    expect(out?.uri).toBe("https://x/files/a:download");
    expect(omniVideoOutput({ steps: [{ type: "thought" }] })).toBeUndefined();
  });

  it("retired Veo ids still resolve, to Omni", () => {
    expect(getMediaModelById("veo-3.1-generate-preview")?.id).toBe("gemini-omni-1.1-flash");
    expect(resolveMediaModel("veo-3.1-fast-generate-preview", { googleApiKey: "k" }).model?.apiStyle).toBe("gemini_omni_interactions");
  });
});
