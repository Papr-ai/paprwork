import { readFile } from "node:fs/promises";
import type { ResolvedMediaModel } from "./types.js";
import type { GeneratedMediaBytes } from "./providers.js";

const CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
const CODEX_ROUTING_MODEL = "gpt-5.5";

function extractBase64FromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 100) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    "result",
    "b64_json",
    "image_base64",
    "image",
    "output",
    "data",
  ]) {
    const nested = record[key];
    if (typeof nested === "string" && nested.length > 100) {
      return nested;
    }
    if (nested && typeof nested === "object") {
      const deep = extractBase64FromUnknown(nested);
      if (deep) return deep;
    }
  }
  return undefined;
}

function parseSseForImageBase64(sseText: string): string | undefined {
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payloadText = trimmed.slice(5).trim();
    if (!payloadText || payloadText === "[DONE]") continue;
    try {
      const payload = JSON.parse(payloadText) as Record<string, unknown>;
      const direct = extractBase64FromUnknown(payload);
      if (direct) return direct;

      const item = payload.item as Record<string, unknown> | undefined;
      if (item) {
        const fromItem = extractBase64FromUnknown(item);
        if (fromItem) return fromItem;
      }

      const response = payload.response as Record<string, unknown> | undefined;
      if (response?.output && Array.isArray(response.output)) {
        for (const outputItem of response.output) {
          const fromOutput = extractBase64FromUnknown(outputItem);
          if (fromOutput) return fromOutput;
        }
      }
    } catch {
      // ignore malformed SSE chunks
    }
  }
  return undefined;
}

async function loadReferenceInputImage(
  referenceImagePath: string,
): Promise<Record<string, unknown>> {
  const bytes = await readFile(referenceImagePath);
  const lower = referenceImagePath.toLowerCase();
  const mimeType = lower.endsWith(".png")
    ? "image/png"
    : lower.endsWith(".webp")
      ? "image/webp"
      : "image/jpeg";
  return {
    type: "input_image",
    image_url: `data:${mimeType};base64,${bytes.toString("base64")}`,
  };
}

export async function generateWithOpenAiCodexOAuth(input: {
  model: ResolvedMediaModel;
  prompt: string;
  referenceImagePath?: string;
}): Promise<GeneratedMediaBytes> {
  if (!input.model.oauthToken || !input.model.oauthAccountId) {
    throw new Error("ChatGPT OAuth credentials missing for Codex image generation.");
  }

  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: input.prompt },
  ];
  if (input.referenceImagePath) {
    content.unshift(await loadReferenceInputImage(input.referenceImagePath));
  }

  const body = {
    model: CODEX_ROUTING_MODEL,
    store: false,
    stream: true,
    instructions:
      "Generate one image from the user prompt using the image_generation tool.",
    input: [
      {
        role: "user",
        content,
      },
    ],
    tools: [
      {
        type: "image_generation",
        model: input.model.codexImageModel ?? input.model.remoteModel,
      },
    ],
    tool_choice: "required",
    parallel_tool_calls: false,
  };

  const response = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.model.oauthToken}`,
      "chatgpt-account-id": input.model.oauthAccountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "paprwork-generate-media",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `ChatGPT OAuth image generation failed (${response.status}): ${responseText.slice(0, 400)}`,
    );
  }

  let base64 = parseSseForImageBase64(responseText);
  if (!base64) {
    try {
      const json = JSON.parse(responseText) as Record<string, unknown>;
      base64 = extractBase64FromUnknown(json);
    } catch {
      // fall through
    }
  }

  if (!base64) {
    throw new Error(
      "ChatGPT OAuth image generation returned no image bytes. Ensure ChatGPT Plus/Pro is active.",
    );
  }

  const normalized = base64.replace(/^data:image\/\w+;base64,/, "");
  return {
    bytes: Buffer.from(normalized, "base64"),
    mimeType: "image/png",
    suggestedExtension: "png",
  };
}
