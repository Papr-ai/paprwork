import { readFile } from "node:fs/promises";
import type { ResolvedMediaModel } from "./types.js";
import type { GeneratedMediaBytes } from "./providers.js";

/**
 * Video via Gemini Omni Flash (Interactions API). Veo 3.1 Preview was shut
 * down in the Gemini API on 2026-10-22; Omni replaces it. One synchronous call
 * (~20-40s); the clip comes back as a Google-hosted file URI we download.
 * https://ai.google.dev/gemini-api/docs/omni
 */
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OMNI_TIMEOUT_MS = 5 * 60 * 1000;

interface OmniContent { type?: string; mime_type?: string; data?: string; uri?: string }
interface OmniInteraction {
  status?: string;
  error?: { message?: string };
  steps?: Array<{ type?: string; content?: OmniContent[] }>;
}

async function loadImage(path: string): Promise<{ type: "image"; data: string; mime_type: string }> {
  const lower = path.toLowerCase();
  const mime_type = lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return { type: "image", data: (await readFile(path)).toString("base64"), mime_type };
}

/** Bind each image to its role with Omni's declared-source tags (Image1 = first input image). */
export function omniRolePrefix(opts: { first: boolean; last: boolean; refs: number }): string {
  let n = 0;
  const sources: string[] = [];
  if (opts.first) sources.push(`<FIRST_FRAME>@Image${++n}`);
  if (opts.last) sources.push(`<LAST_FRAME>@Image${++n}`);
  const refs = Array.from({ length: opts.refs }, (_, i) => `<IMAGE_REF_${i}>@Image${++n}`);
  return [
    sources.length ? `[# Sources ${sources.join(" ")}]` : "",
    refs.length ? `[# References ${refs.join(" ")}]` : "",
  ].filter(Boolean).join(" ");
}

export function omniVideoOutput(payload: OmniInteraction): OmniContent | undefined {
  for (const step of payload.steps ?? []) {
    if (step.type !== "model_output") continue;
    const video = step.content?.find((c) => c.type === "video");
    if (video) return video;
  }
  return undefined;
}

export async function generateWithOmniVideoModel(input: {
  model: ResolvedMediaModel;
  apiKey: string;
  prompt: string;
  aspectRatio?: string;
  /** First frame (image-to-video). */
  referenceImagePath?: string;
  /** Last frame: Omni interpolates from the first frame to this one. Requires referenceImagePath. */
  lastFramePath?: string;
  /** Up to 3 images of a character/object/style to keep consistent. */
  referenceImagePaths?: string[];
}): Promise<GeneratedMediaBytes> {
  if (input.lastFramePath && !input.referenceImagePath) {
    throw new Error("lastFramePath needs referenceImagePath (the first frame).");
  }
  const refPaths = input.referenceImagePaths ?? [];
  if (refPaths.length > 3) throw new Error("At most 3 referenceImagePaths.");

  const images = await Promise.all(
    [input.referenceImagePath, input.lastFramePath, ...refPaths]
      .filter((p): p is string => Boolean(p))
      .map(loadImage),
  );
  const prefix = omniRolePrefix({
    first: Boolean(input.referenceImagePath),
    last: Boolean(input.lastFramePath),
    refs: refPaths.length,
  });
  const text = prefix ? `${prefix} ${input.prompt}` : input.prompt;

  const res = await fetch(`${GEMINI_API_BASE}/interactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": input.apiKey },
    signal: AbortSignal.timeout(OMNI_TIMEOUT_MS),
    body: JSON.stringify({
      model: input.model.remoteModel,
      input: images.length ? [...images, { type: "text", text }] : text,
      response_format: {
        type: "video",
        aspect_ratio: input.aspectRatio === "9:16" ? "9:16" : "16:9",
        resolution: "720p",
        // Clips are often > 4MB; URI delivery avoids the inline payload limit.
        // (URI delivery requires store=true, the API default.)
        delivery: "uri",
      },
    }),
  });
  const payload = (await res.json().catch(() => ({}))) as OmniInteraction;
  if (!res.ok || payload.error) {
    throw new Error(payload.error?.message ?? `Video generation failed (${res.status}).`);
  }
  const video = omniVideoOutput(payload);
  if (video?.data) {
    return { bytes: Buffer.from(video.data, "base64"), mimeType: video.mime_type ?? "video/mp4", suggestedExtension: "mp4" };
  }
  if (!video?.uri) throw new Error(`Video generation returned no video (status ${payload.status ?? "unknown"}).`);
  const dl = await fetch(video.uri, { headers: { "x-goog-api-key": input.apiKey }, signal: AbortSignal.timeout(OMNI_TIMEOUT_MS) });
  if (!dl.ok) throw new Error(`Failed to download the generated video (${dl.status}).`);
  return { bytes: Buffer.from(await dl.arrayBuffer()), mimeType: video.mime_type ?? "video/mp4", suggestedExtension: "mp4" };
}
