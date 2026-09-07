import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import type { GeneratedMediaArtifact } from "./types.js";

function sanitizeFileStem(value: string): string {
  const stem = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return stem || "generated-media";
}

const KNOWN_MEDIA_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "mp4",
  "mov",
]);

function normalizeExtension(ext: string): string {
  return ext.replace(/^\./, "").toLowerCase();
}

/** Resolve output filename — appends suggestedExtension when the stem has none. */
export function resolveGeneratedMediaFileName(input: {
  fileName?: string;
  suggestedExtension: string;
  modelId: string;
  sha256Prefix: string;
}): string {
  const suggestedExt = normalizeExtension(input.suggestedExtension);

  if (!input.fileName?.trim()) {
    return `${sanitizeFileStem(input.modelId)}-${input.sha256Prefix.slice(0, 8)}.${suggestedExt}`;
  }

  const trimmed = input.fileName.trim();
  const ext = normalizeExtension(path.extname(trimmed));

  if (ext && KNOWN_MEDIA_EXTENSIONS.has(ext)) {
    const stem = path.basename(trimmed, path.extname(trimmed));
    return `${sanitizeFileStem(stem)}.${ext === "jpeg" ? "jpg" : ext}`;
  }

  return `${sanitizeFileStem(trimmed)}.${suggestedExt}`;
}

function gatewayBaseUrl(): string {
  const port = process.env.GATEWAY_PORT ?? "18789";
  return (process.env.PAPR_GATEWAY_URL ?? `http://127.0.0.1:${port}`).replace(
    /\/$/,
    "",
  );
}

async function registerWithAppFiles(input: {
  appId: string;
  localPath: string;
  fileName: string;
  mimeType: string;
}): Promise<string> {
  const response = await fetch(`${gatewayBaseUrl()}/api/files/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appId: input.appId,
      filePath: input.localPath,
      fileName: input.fileName,
      mime: input.mimeType,
      scope: "app",
      keepLocal: true,
    }),
  });

  const payload = (await response.json()) as { id?: string; error?: string };
  if (!response.ok || !payload.id) {
    throw new Error(
      payload.error ??
        `App Files registration failed (${response.status}) for ${input.fileName}`,
    );
  }
  return payload.id;
}

export async function persistGeneratedMedia(input: {
  bytes: Buffer;
  mimeType: string;
  suggestedExtension: string;
  modelId: string;
  kind: GeneratedMediaArtifact["kind"];
  fileName?: string;
  appId?: string;
  jobDir?: string;
}): Promise<GeneratedMediaArtifact> {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const fileName = resolveGeneratedMediaFileName({
    fileName: input.fileName,
    suggestedExtension: input.suggestedExtension,
    modelId: input.modelId,
    sha256Prefix: sha256,
  });

  const baseDir =
    input.jobDir?.trim() ||
    path.join(getPaprRoot(), "data", "generated-media");
  await mkdir(baseDir, { recursive: true });
  const localPath = path.join(baseDir, fileName);
  await writeFile(localPath, input.bytes);

  let appFileId: string | undefined;
  if (input.appId) {
    appFileId = await registerWithAppFiles({
      appId: input.appId,
      localPath,
      fileName,
      mimeType: input.mimeType,
    });
  }

  return {
    modelId: input.modelId,
    kind: input.kind,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.length,
    localPath,
    fileName,
    appId: input.appId,
    appFileId,
    sha256Prefix: sha256.slice(0, 16),
  };
}
