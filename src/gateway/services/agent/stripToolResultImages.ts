/**
 * Strip inline base64 images from tool results before they reach the model.
 *
 * webview_launch_app, webview_snapshot and validate_app return a PNG as a
 * `data:image/...;base64,` string (screenshot / previewScreenshot /
 * screenshots). The chat card renders it from the STORED result; the model
 * only ever sees it as text, where it is unreadable and costs ~25K tokens per
 * call. Worse, it sits before the page text in the JSON, so the 40K cap cut
 * off the snapshot's sections/elements entirely.
 *
 * Apply this only on the model-input side (in-flight context and history
 * formatting). Never on what is persisted or streamed to the UI.
 */

export const IMAGE_OMITTED_PLACEHOLDER =
  "[image omitted: shown to the user in chat, not visible to you]";

/** `data:image/<subtype>;base64,<payload>` — base64 has no quotes, so this is safe inside JSON text. */
const INLINE_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

/** Below this a data URI is likely an intentional tiny icon, not a screenshot. */
const MIN_STRIPPED_LENGTH = 1_000;

/** Stringified result (JSON or plain text) → same text with large inline images replaced. */
export function stripInlineImagesFromText(text: string): string {
  if (!text.includes("data:image/")) return text;
  return text.replace(INLINE_IMAGE_RE, (match) =>
    match.length >= MIN_STRIPPED_LENGTH ? IMAGE_OMITTED_PLACEHOLDER : match,
  );
}

/**
 * Structured result → copy with large inline-image strings replaced. Returns
 * the original reference when nothing was stripped (cheap common case).
 */
export function stripInlineImagesFromValue<T>(value: T): T {
  return strip(value, 0) as T;
}

function strip(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length >= MIN_STRIPPED_LENGTH && value.startsWith("data:image/")
      ? IMAGE_OMITTED_PLACEHOLDER
      : stripInlineImagesFromText(value);
  }
  if (depth > 20 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = strip(item, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = strip(item, depth + 1);
    if (next !== item) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

export interface SeeImage {
  mimeType: string;
  /** Raw base64 (no data: prefix). */
  data: string;
}

/**
 * The screenshot a tool explicitly asked the model to see
 * (`webview_snapshot({ see: true })` sets `data.seeScreenshot`). Callers attach
 * it as a real image part — only for vision models — and still strip the
 * base64 text from the JSON.
 */
export function extractSeeImage(result: unknown): SeeImage | null {
  const data = (result as { data?: Record<string, unknown> } | null)?.data;
  if (!data || data.seeScreenshot !== true) return null;
  const uri = data.screenshot;
  if (typeof uri !== "string") return null;
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(uri);
  return m ? { mimeType: m[1], data: m[2] } : null;
}

export const SEE_IMAGE_ATTACHED_NOTE =
  "[screenshot attached as an image below — this is what the user sees]";
