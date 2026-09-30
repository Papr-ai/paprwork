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

function mapAspectRatioToVeoResolution(
  aspectRatio: string | undefined,
): "720p" | "1080p" {
  return aspectRatio === "9:16" ? "720p" : "1080p";
}

async function loadReferenceImageBytes(
  referenceImagePath: string,
): Promise<string> {
  const bytes = await readFile(referenceImagePath);
  return bytes.toString("base64");
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
  referenceImagePath?: string;
}): Promise<GeneratedMediaBytes> {
  const instance: Record<string, unknown> = { prompt: input.prompt };
  if (input.referenceImagePath) {
    instance.image = {
      bytesBase64Encoded: await loadReferenceImageBytes(input.referenceImagePath),
    };
  }

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
        resolution: mapAspectRatioToVeoResolution(input.aspectRatio),
        durationSeconds:
          input.durationSeconds ?? input.model.defaultDurationSeconds ?? 8,
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
