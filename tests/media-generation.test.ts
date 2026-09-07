import { describe, expect, it } from "vitest";
import {
  listMediaModels,
  openAiSizeForAspectRatio,
  resolveMediaModel,
} from "../src/gateway/services/mediaGeneration/models.js";
import type { MediaAuthContext } from "../src/gateway/services/mediaGeneration/mediaAuth.js";

describe("media generation models", () => {
  it("lists Google models when Google API key is configured", () => {
    const result = listMediaModels({
      googleApiKey: "google-key",
    });

    expect(result.available.some((m) => m.id === "gemini-3.1-flash-image")).toBe(
      true,
    );
    expect(result.available.some((m) => m.id === "veo-3.1-generate-preview")).toBe(
      true,
    );
    expect(result.unavailable.some((m) => m.id === "gpt-image-2")).toBe(true);
  });

  it("accepts GOOGLE_GENERATIVE_AI_API_KEY via googleApiKey context", () => {
    const resolved = resolveMediaModel("gemini-3-pro-image", {
      googleApiKey: "abc",
    });
    expect(resolved.model?.id).toBe("gemini-3-pro-image");
    expect(resolved.model?.authKind).toBe("google_api_key");
  });

  it("prefers ChatGPT OAuth over Platform key for gpt-image-2", () => {
    const ctx: MediaAuthContext = {
      openaiPlatformKey: "sk-proj-real",
      openaiOAuth: {
        token: "eyJ.test.token",
        accountId: "user-123",
      },
    };
    const resolved = resolveMediaModel("gpt-image-2", ctx);
    expect(resolved.model?.authKind).toBe("openai_oauth");
    expect(resolved.model?.apiStyle).toBe("openai_codex_image");
  });

  it("uses Platform API key when OAuth is not configured", () => {
    const resolved = resolveMediaModel("gpt-image-2", {
      openaiPlatformKey: "sk-proj-real",
    });
    expect(resolved.model?.authKind).toBe("openai_platform");
    expect(resolved.model?.apiStyle).toBe("openai_images");
  });

  it("reports missing OpenAI auth for gpt-image-2", () => {
    const model = resolveMediaModel("gpt-image-2", {});
    expect(model.error).toMatch(/missing OPENAI_API_KEY or ChatGPT OAuth/);
  });

  it("maps aspect ratios to OpenAI sizes", () => {
    expect(openAiSizeForAspectRatio("16:9", "gpt-image-2")).toBe("1536x1024");
    expect(openAiSizeForAspectRatio("1:1", "gpt-image-2")).toBe("1024x1024");
  });
});
