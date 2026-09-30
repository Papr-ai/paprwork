/**
 * Native vision — inject pasted/attached images into LLM user messages.
 *
 * Images are read from disk on the gateway and sent as multimodal content parts
 * (AI SDK ImagePart / pi-ai ImageContent). PDFs and non-vision models keep the
 * existing Papr Memory + tool-based path.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ModelFallback } from "../../../core/agents/ModelFallback.js";
import type { StoredMessageAttachment } from "../storage/IStorageProvider.js";
import type { AIModelMessage, UserContentPart } from "./historyFormatter.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 4;

const VISION_MIME_PREFIX = "image/";
const VISION_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

const modelFallback = new ModelFallback();

function expandHome(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", filePath.slice(2));
  }
  return filePath;
}

function normalizeModelId(modelId: string): string {
  return modelId.replace(/-(low|high|medium|xhigh|minimal)$/i, "");
}

export function modelSupportsVision(provider: string, modelId: string): boolean {
  const direct = modelFallback.getModelInfo(modelId);
  if (direct) return direct.supportsVision;

  const normalized = modelFallback.getModelInfo(normalizeModelId(modelId));
  if (normalized) return normalized.supportsVision;

  switch (provider) {
    case "anthropic":
    case "openai":
    case "google":
    case "moonshot":
      return true;
    case "ollama":
    case "groq":
    case "cursor":
      return false;
    default:
      return false;
  }
}

export function isVisionEligibleAttachment(
  attachment: StoredMessageAttachment,
): boolean {
  if (!attachment.filePath) return false;

  const mime = (attachment.mimeType ?? "").toLowerCase();
  if (mime === "image/svg+xml") return false;
  if (mime.startsWith(VISION_MIME_PREFIX)) return true;

  const ext = path.extname(attachment.name || attachment.filePath).toLowerCase();
  return VISION_EXTENSIONS.has(ext);
}

async function loadImageBase64(
  filePath: string,
): Promise<{ base64: string; mimeType: string } | null> {
  const resolved = expandHome(filePath);
  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile() || fileStat.size > MAX_IMAGE_BYTES) {
      return null;
    }

    const buffer = await readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mimeType =
      ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".gif"
            ? "image/gif"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".bmp"
                ? "image/bmp"
                : "image/png";

    return { base64: buffer.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

function userMessageText(content: string | UserContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Replace string user content with text + image parts for messages that carry
 * image attachments. Mutates `messages` in place and strips `attachments`.
 */
export async function injectAttachmentVisionIntoMessages(
  messages: AIModelMessage[],
): Promise<number> {
  let injectedCount = 0;

  for (const message of messages) {
    if (message.role !== "user") continue;

    const userMsg = message as Extract<
      AIModelMessage,
      { role: "user"; attachments?: StoredMessageAttachment[] }
    >;
    const attachments = userMsg.attachments;
    if (!attachments?.length) continue;

    const imageParts: UserContentPart[] = [];
    for (const attachment of attachments) {
      if (!isVisionEligibleAttachment(attachment)) continue;
      if (imageParts.length >= MAX_IMAGES_PER_MESSAGE) break;
      if (!attachment.filePath) continue;

      const loaded = await loadImageBase64(attachment.filePath);
      if (!loaded) continue;

      imageParts.push({
        type: "image",
        image: loaded.base64,
        mediaType: loaded.mimeType,
      });
    }

    delete userMsg.attachments;

    if (imageParts.length === 0) continue;

    const text = userMessageText(userMsg.content).trim();
    userMsg.content = [
      {
        type: "text",
        text: text || "Please review the attached image(s).",
      },
      ...imageParts,
    ];
    injectedCount += imageParts.length;
  }

  return injectedCount;
}
