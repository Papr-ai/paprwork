import type { MediaAuthContext } from "./mediaAuth.js";
import { describeOpenAiMediaAuth } from "./mediaAuth.js";
import type {
  ListMediaModelsResult,
  MediaModelDefinition,
  ResolvedMediaModel,
} from "./types.js";

export const MEDIA_MODELS: readonly MediaModelDefinition[] = [
  {
    id: "gemini-3.1-flash-image",
    label: "Gemini 3.1 Flash Image",
    kind: "image",
    provider: "google",
    apiStyle: "gemini_generate_content",
    remoteModel: "gemini-3.1-flash-image",
    implemented: true,
    defaultAspectRatio: "1:1",
    supportedAspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
  },
  {
    id: "gemini-3-pro-image",
    label: "Gemini 3 Pro Image",
    kind: "image",
    provider: "google",
    apiStyle: "gemini_generate_content",
    remoteModel: "gemini-3-pro-image",
    implemented: true,
    defaultAspectRatio: "1:1",
    supportedAspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
  },
  {
    id: "gpt-image-2",
    label: "GPT Image 2",
    kind: "image",
    provider: "openai",
    apiStyle: "openai_images",
    remoteModel: "gpt-image-2",
    codexImageModel: "gpt-image-2",
    implemented: true,
    defaultAspectRatio: "1:1",
    supportedAspectRatios: ["1:1", "3:2", "2:3", "16:9", "9:16"],
  },
  {
    id: "gpt-image-2.5-flare",
    label: "GPT Image 2.5 Flare",
    kind: "image",
    provider: "openai",
    apiStyle: "openai_images",
    remoteModel: "gpt-image-2.5-flare",
    codexImageModel: "gpt-image-2.5-flare",
    implemented: true,
    defaultAspectRatio: "1:1",
    supportedAspectRatios: ["1:1", "3:2", "2:3", "16:9", "9:16"],
  },
  {
    id: "gpt-image-2.5-sunburst",
    label: "GPT Image 2.5 Sunburst",
    kind: "image",
    provider: "openai",
    apiStyle: "openai_images",
    remoteModel: "gpt-image-2.5-sunburst",
    codexImageModel: "gpt-image-2.5-sunburst",
    implemented: true,
    defaultAspectRatio: "1:1",
    supportedAspectRatios: ["1:1", "3:2", "2:3", "16:9", "9:16"],
  },
  {
    id: "veo-3.1-generate-preview",
    label: "Veo 3.1",
    kind: "video",
    provider: "google",
    apiStyle: "veo_predict_long_running",
    remoteModel: "veo-3.1-generate-preview",
    implemented: true,
    defaultAspectRatio: "16:9",
    supportedAspectRatios: ["16:9", "9:16"],
    defaultDurationSeconds: 8,
  },
  {
    id: "veo-3.1-fast-generate-preview",
    label: "Veo 3.1 Fast",
    kind: "video",
    provider: "google",
    apiStyle: "veo_predict_long_running",
    remoteModel: "veo-3.1-fast-generate-preview",
    implemented: true,
    defaultAspectRatio: "16:9",
    supportedAspectRatios: ["16:9", "9:16"],
    defaultDurationSeconds: 8,
  },
] as const;

export function getMediaModelById(modelId: string): MediaModelDefinition | undefined {
  return MEDIA_MODELS.find((model) => model.id === modelId);
}

function resolveGoogleModel(
  model: MediaModelDefinition,
  ctx: MediaAuthContext,
): ResolvedMediaModel | undefined {
  if (!ctx.googleApiKey) return undefined;
  return {
    ...model,
    authKind: "google_api_key",
    apiKey: ctx.googleApiKey,
  };
}

function resolveOpenAiModel(
  model: MediaModelDefinition,
  ctx: MediaAuthContext,
): ResolvedMediaModel | undefined {
  if (ctx.openaiOAuth) {
    return {
      ...model,
      apiStyle: "openai_codex_image",
      authKind: "openai_oauth",
      oauthToken: ctx.openaiOAuth.token,
      oauthAccountId: ctx.openaiOAuth.accountId,
    };
  }
  if (ctx.openaiPlatformKey) {
    return {
      ...model,
      apiStyle: "openai_images",
      authKind: "openai_platform",
      apiKey: ctx.openaiPlatformKey,
    };
  }
  return undefined;
}

export function resolveMediaModel(
  modelId: string,
  ctx: MediaAuthContext,
): { model?: ResolvedMediaModel; error?: string } {
  const model = getMediaModelById(modelId);
  if (!model) {
    return {
      error: `Unknown model "${modelId}". Call list_media_models to see supported models.`,
    };
  }
  if (!model.implemented) {
    return {
      error:
        model.unavailableReason ??
        `Model "${model.id}" is not available in generate_media yet.`,
    };
  }

  const resolved =
    model.provider === "google"
      ? resolveGoogleModel(model, ctx)
      : model.provider === "openai"
        ? resolveOpenAiModel(model, ctx)
        : undefined;

  if (!resolved) {
    if (model.provider === "google") {
      return {
        error: `No Google API key for ${model.label}. Add GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY in Settings.`,
      };
    }
    return {
      error: `No OpenAI auth for ${model.label}. ${describeOpenAiMediaAuth(ctx)}.`,
    };
  }

  return { model: resolved };
}

function authPathLabel(model: ResolvedMediaModel): string {
  switch (model.authKind) {
    case "google_api_key":
      return "Google API key";
    case "openai_platform":
      return "OpenAI Platform API key";
    case "openai_oauth":
      return "ChatGPT OAuth (Codex)";
    default: {
      const _exhaustive: never = model.authKind;
      return String(_exhaustive);
    }
  }
}

export function listMediaModels(ctx: MediaAuthContext): ListMediaModelsResult {
  const available: ListMediaModelsResult["available"] = [];
  const unavailable: ListMediaModelsResult["unavailable"] = [];

  for (const model of MEDIA_MODELS) {
    if (!model.implemented) {
      unavailable.push({
        id: model.id,
        label: model.label,
        kind: model.kind,
        reason:
          model.unavailableReason ??
          "Not implemented in generate_media yet.",
      });
      continue;
    }

    const resolved =
      model.provider === "google"
        ? resolveGoogleModel(model, ctx)
        : resolveOpenAiModel(model, ctx);

    if (!resolved) {
      unavailable.push({
        id: model.id,
        label: model.label,
        kind: model.kind,
        reason:
          model.provider === "google"
            ? "Missing GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY"
            : describeOpenAiMediaAuth(ctx),
      });
      continue;
    }

    available.push({
      id: model.id,
      label: model.label,
      kind: model.kind,
      provider: model.provider,
      authPath: authPathLabel(resolved),
      defaultAspectRatio: model.defaultAspectRatio,
      supportedAspectRatios: model.supportedAspectRatios,
    });
  }

  return { available, unavailable };
}

export function openAiSizeForAspectRatio(
  aspectRatio: string | undefined,
  modelId: string,
): string {
  const ratio = aspectRatio ?? "1:1";
  if (ratio === "16:9" || ratio === "3:2") return "1536x1024";
  if (ratio === "9:16" || ratio === "2:3") return "1024x1536";
  if (modelId.startsWith("gpt-image-")) return "1024x1024";
  return "1024x1024";
}

export function openAiImageQuality(modelId: string): string {
  if (modelId === "gpt-image-2.5-sunburst") return "high";
  if (modelId.startsWith("gpt-image-2.5-")) return "auto";
  return "medium";
}
