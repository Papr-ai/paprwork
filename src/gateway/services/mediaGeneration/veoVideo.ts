import { readFile } from "node:fs/promises";
import type { ResolvedMediaModel } from "./types.js";
import type { GeneratedMediaBytes } from "./providers.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface VeoStartResponse {
  name?: string;
  error?: { message?: string };
}

interface VeoOperationResponse {
  done?: boolean;
  error?: { message?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{
        video?: { uri?: string };
      }>;
    };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 1080p is only accepted for 8-second 16:9 clips; everything else must be 720p. */
function mapAspectRatioToVeoResolution(
  aspectRatio: string | undefined,
  durationSeconds: number,
): "720p" | "1080p" {
  return aspectRatio !== "9:16" && durationSeconds === 8 ? "1080p" : "720p";
}

/** Veo rejects an image without its mimeType ("should contain both bytesBase64Encoded and mimeType"). */
async function loadVeoImage(
  imagePath: string,
): Promise<{ bytesBase64Encoded: string; mimeType: string }> {
  const bytes = await readFile(imagePath);
  const lower = imagePath.toLowerCase();
  const mimeType = lower.endsWith(".png")
    ? "image/png"
    : lower.endsWith(".webp")
      ? "image/webp"
      : "image/jpeg";
  return { bytesBase64Encoded: bytes.toString("base64"), mimeType };
}

async function pollVeoOperation(
  apiKey: string,
  operationName: string,
): Promise<string> {
  const pollUrl = operationName.startsWith("http")
    ? operationName
    : `${GEMINI_API_BASE}/${operationName.replace(/^\//, "")}`;

  const deadlineMs = Date.now() + 10 * 60 * 1000;
  let delayMs = 10_000;

  while (Date.now() < deadlineMs) {
    const response = await fetch(pollUrl, {
      headers: { "x-goog-api-key": apiKey },
    });
    const payload = (await response.json()) as VeoOperationResponse;
    if (!response.ok) {
      throw new Error(
        payload.error?.message ?? `Veo operation poll failed (${response.status})`,
      );
    }

    if (payload.done) {
      const videoUri =
        payload.response?.generateVideoResponse?.generatedSamples?.[0]?.video
          ?.uri;
      if (!videoUri) {
        throw new Error("Veo operation completed but returned no video URI.");
      }
      return videoUri;
    }

    await sleep(delayMs);
    delayMs = Math.min(Math.round(delayMs * 1.25), 20_000);
  }

  throw new Error("Veo video generation timed out after 10 minutes.");
}

async function downloadVideo(apiKey: string, videoUri: string): Promise<Buffer> {
  const response = await fetch(videoUri, {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!response.ok) {
    throw new Error(`Failed to download Veo video (${response.status}).`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function generateWithVeoModel(input: {
  model: ResolvedMediaModel;
  apiKey: string;
  prompt: string;
  aspectRatio?: string;
  durationSeconds?: number;
  /** First frame (image-to-video). */
  referenceImagePath?: string;
  /** Last frame: Veo interpolates from the first frame to this one. Requires referenceImagePath. */
  lastFramePath?: string;
  /** Up to 3 asset images (character/object) to keep consistent across the clip. */
  referenceImagePaths?: string[];
}): Promise<GeneratedMediaBytes> {
  if (input.lastFramePath && !input.referenceImagePath) {
    throw new Error("lastFramePath needs referenceImagePath (the first frame).");
  }
  if ((input.referenceImagePaths?.length ?? 0) > 3) {
    throw new Error("Veo accepts at most 3 referenceImagePaths.");
  }
  const instance: Record<string, unknown> = { prompt: input.prompt };
  if (input.referenceImagePath) {
    instance.image = await loadVeoImage(input.referenceImagePath);
  }
  if (input.lastFramePath) {
    instance.lastFrame = await loadVeoImage(input.lastFramePath);
  }
  if (input.referenceImagePaths?.length) {
    instance.referenceImages = await Promise.all(
      input.referenceImagePaths.map(async (path) => ({
        image: await loadVeoImage(path),
        referenceType: "asset",
      })),
    );
  }
  // Veo rejects lastFrame / referenceImages on shorter clips ("use case is currently not supported").
  const needsEight = Boolean(input.lastFramePath || input.referenceImagePaths?.length);
  if (needsEight && input.durationSeconds !== undefined && input.durationSeconds !== 8) {
    throw new Error("Veo needs durationSeconds 8 when lastFramePath or referenceImagePaths is set.");
  }
  const durationSeconds = needsEight
    ? 8
    : (input.durationSeconds ?? input.model.defaultDurationSeconds ?? 8);

  const startUrl = `${GEMINI_API_BASE}/models/${encodeURIComponent(input.model.remoteModel)}:predictLongRunning`;
  const startResponse = await fetch(startUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": input.apiKey,
    },
    body: JSON.stringify({
      instances: [instance],
      parameters: {
        aspectRatio: input.aspectRatio ?? input.model.defaultAspectRatio ?? "16:9",
        resolution: mapAspectRatioToVeoResolution(input.aspectRatio, durationSeconds),
        durationSeconds,
        sampleCount: 1,
      },
    }),
  });

  const startPayload = (await startResponse.json()) as VeoStartResponse;
  if (!startResponse.ok || !startPayload.name) {
    throw new Error(
      startPayload.error?.message ??
        `Veo video start failed (${startResponse.status})`,
    );
  }

  const videoUri = await pollVeoOperation(input.apiKey, startPayload.name);
  const bytes = await downloadVideo(input.apiKey, videoUri);

  return {
    bytes,
    mimeType: "video/mp4",
    suggestedExtension: "mp4",
  };
}
