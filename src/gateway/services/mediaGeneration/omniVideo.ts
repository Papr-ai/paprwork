import { readFile } from "node:fs/promises";
import type { ResolvedMediaModel } from "./types.js";
import type { GeneratedMediaBytes } from "./providers.js";

const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
/** A clip usually takes 30-90s; allow for slow queues. */
const OMNI_TIMEOUT_MS = 10 * 60 * 1000;

interface OmniContent {
  type?: string;
  data?: string;
  uri?: string;
  mime_type?: string;
}

interface OmniInteraction {
  status?: string;
  steps?: Array<{ type?: string; content?: OmniContent[] }>;
  error?: { message?: string };
}

type OmniInput =
  | { type: "image"; data: string; mime_type: string }
  | { type: "text"; text: string };

async function loadImage(path: string): Promise<OmniInput> {
  const lower = path.toLowerCase();
  const mime_type = lower.endsWith(".png")
    ? "image/png"
    : lower.endsWith(".webp")
      ? "image/webp"
      : "image/jpeg";
  return { type: "image", data: (await readFile(path)).toString("base64"), mime_type };
}

/**
 * Omni binds images to roles with tags declared ahead of the prompt.
 * Images are numbered in input order: first frame, last frame, then references.
 */
export function buildOmniPrompt(input: {
  prompt: string;
  hasFirstFrame: boolean;
  hasLastFrame: boolean;
  referenceCount: number;
}): string {
  let n = 0;
  const sources: string[] = [];
  if (input.hasFirstFrame) sources.push(`<FIRST_FRAME>@Image${++n}`);
  if (input.hasLastFrame) sources.push(`<LAST_FRAME>@Image${++n}`);
  const refs = Array.from({ length: input.referenceCount }, (_, i) => `<IMAGE_REF_${i}>@Image${++n}`);
  const head = [
    sources.length ? `[# Sources ${sources.join(" ")}]` : "",
    refs.length ? `[# References ${refs.join(" ")}]` : "",
  ].filter(Boolean);
  return head.length ? `${head.join(" ")} ${input.prompt}` : input.prompt;
}

export async function generateWithOmniModel(input: {
  model: ResolvedMediaModel;
  apiKey: string;
  prompt: string;
  aspectRatio?: string;
  /** First frame (image-to-video). */
  referenceImagePath?: string;
  /** Last frame: Omni animates from the first frame to this one. Requires referenceImagePath. */
  lastFramePath?: string;
  /** Up to 3 images of a character, object or style to keep consistent. */
  referenceImagePaths?: string[];
}): Promise<GeneratedMediaBytes> {
  if (input.lastFramePath && !input.referenceImagePath) {
    throw new Error("lastFramePath needs referenceImagePath (the first frame).");
  }
  const refs = input.referenceImagePaths ?? [];
  if (refs.length > 3) throw new Error("Gemini Omni accepts at most 3 referenceImagePaths.");

  const images = [input.referenceImagePath, input.lastFramePath, ...refs].filter(
    (p): p is string => Boolean(p),
  );
  const text = buildOmniPrompt({
    prompt: input.prompt,
    hasFirstFrame: Boolean(input.referenceImagePath),
    hasLastFrame: Boolean(input.lastFramePath),
    referenceCount: refs.length,
  });
  const body = {
    model: input.model.remoteModel,
    input: images.length
      ? [...(await Promise.all(images.map(loadImage))), { type: "text", text }]
      : text,
    response_format: {
      type: "video",
      aspect_ratio: input.aspectRatio === "9:16" ? "9:16" : "16:9",
    },
    store: false,
  };

  const response = await fetch(INTERACTIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": input.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(OMNI_TIMEOUT_MS),
  });
  const payload = (await response.json()) as OmniInteraction;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Gemini Omni video failed (${response.status})`);
  }
  const video = (payload.steps ?? [])
    .flatMap((step) => step.content ?? [])
    .find((c) => c.type === "video");
  if (video?.data) {
    return { bytes: Buffer.from(video.data, "base64"), mimeType: video.mime_type ?? "video/mp4", suggestedExtension: "mp4" };
  }
  if (video?.uri) {
    const dl = await fetch(video.uri, { headers: { "x-goog-api-key": input.apiKey } });
    if (!dl.ok) throw new Error(`Failed to download Gemini Omni video (${dl.status}).`);
    return { bytes: Buffer.from(await dl.arrayBuffer()), mimeType: "video/mp4", suggestedExtension: "mp4" };
  }
  throw new Error(`Gemini Omni returned no video (status ${payload.status ?? "unknown"}).`);
}
