import { readFile } from "node:fs/promises";
import type { ResolvedMediaModel } from "./types.js";
import { openAiImageQuality, openAiSizeForAspectRatio } from "./models.js";
import { generateWithOpenAiCodexOAuth } from "./openaiCodexImage.js";
import { generateWithVeoModel } from "./veoVideo.js";

export interface GeneratedMediaBytes {
  bytes: Buffer;
  mimeType: string;
  suggestedExtension: string;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
  }>;
  error?: { message?: string };
}

interface OpenAiImagesResponse {
  data?: Array<{ b64_json?: string }>;
  error?: { message?: string };
}

function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "video/mp4":
      return "mp4";
    case "image/png":
    default:
      return "png";
  }
}

function decodeInlineImagePart(part: GeminiPart): GeneratedMediaBytes | null {
  const inline = part.inlineData ?? part.inline_data;
  if (!inline?.data) return null;
  const mimeType =
    ("mimeType" in inline && inline.mimeType) ||
    ("mime_type" in inline && inline.mime_type) ||
    "image/png";
  return {
    bytes: Buffer.from(inline.data, "base64"),
    mimeType,
    suggestedExtension: extensionForMime(mimeType),
  };
}

async function loadReferenceImageBase64(
  referenceImagePath: string,
): Promise<{ mimeType: string; data: string }> {
  const bytes = await readFile(referenceImagePath);
  const lower = referenceImagePath.toLowerCase();
  const mimeType = lower.endsWith(".png")
    ? "image/png"
    : lower.endsWith(".webp")
      ? "image/webp"
      : lower.endsWith(".gif")
        ? "image/gif"
        : "image/jpeg";
  return { mimeType, data: bytes.toString("base64") };
}

export async function generateWithGeminiImageModel(input: {
  model: ResolvedMediaModel;
  apiKey: string;
  prompt: string;
  aspectRatio?: string;
  referenceImagePath?: string;
}): Promise<GeneratedMediaBytes> {
  const parts: Array<Record<string, unknown>> = [{ text: input.prompt }];
  if (input.referenceImagePath) {
    const ref = await loadReferenceImageBase64(input.referenceImagePath);
    parts.unshift({
      inline_data: {
        mime_type: ref.mimeType,
        data: ref.data,
      },
    });
  }

  const body: Record<string, unknown> = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: input.aspectRatio ?? input.model.defaultAspectRatio ?? "1:1",
      },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model.remoteModel)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": input.apiKey,
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as GeminiGenerateContentResponse;
  if (!response.ok) {
    throw new Error(
      payload.error?.message ??
        `Gemini image generation failed (${response.status})`,
    );
  }

  for (const candidate of payload.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const decoded = decodeInlineImagePart(part);
      if (decoded) return decoded;
    }
  }

  throw new Error(
    "Gemini returned no image data. Try a different prompt or model.",
  );
}

export async function generateWithOpenAiImageModel(input: {
  model: ResolvedMediaModel;
  apiKey: string;
  prompt: string;
  aspectRatio?: string;
}): Promise<GeneratedMediaBytes> {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model.remoteModel,
      prompt: input.prompt,
      n: 1,
      size: openAiSizeForAspectRatio(input.aspectRatio, input.model.id),
      quality: openAiImageQuality(input.model.id),
      response_format: "b64_json",
    }),
  });

  const payload = (await response.json()) as OpenAiImagesResponse;
  if (!response.ok) {
    throw new Error(
      payload.error?.message ??
        `OpenAI image generation failed (${response.status})`,
    );
  }

  const b64 = payload.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI returned no image data.");
  }

  return {
    bytes: Buffer.from(b64, "base64"),
    mimeType: "image/png",
    suggestedExtension: "png",
  };
}

export async function generateMediaBytes(input: {
  model: ResolvedMediaModel;
  prompt: string;
  aspectRatio?: string;
  durationSeconds?: number;
  referenceImagePath?: string;
}): Promise<GeneratedMediaBytes> {
  switch (input.model.apiStyle) {
    case "gemini_generate_content": {
      if (!input.model.apiKey) {
        throw new Error("Missing Google API key.");
      }
      return generateWithGeminiImageModel({
        model: input.model,
        apiKey: input.model.apiKey,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
        referenceImagePath: input.referenceImagePath,
      });
    }
    case "veo_predict_long_running": {
      if (!input.model.apiKey) {
        throw new Error("Missing Google API key.");
      }
      return generateWithVeoModel({
        model: input.model,
        apiKey: input.model.apiKey,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
        durationSeconds: input.durationSeconds,
        referenceImagePath: input.referenceImagePath,
      });
    }
    case "openai_images": {
      if (!input.model.apiKey) {
        throw new Error("Missing OpenAI Platform API key.");
      }
      return generateWithOpenAiImageModel({
        model: input.model,
        apiKey: input.model.apiKey,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
      });
    }
    case "openai_codex_image":
      return generateWithOpenAiCodexOAuth({
        model: input.model,
        prompt: input.prompt,
        referenceImagePath: input.referenceImagePath,
      });
    default: {
      const _exhaustive: never = input.model.apiStyle;
      throw new Error(`Unsupported media API style: ${String(_exhaustive)}`);
    }
  }
}
