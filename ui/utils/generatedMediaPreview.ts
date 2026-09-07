import { getGatewayHttpBase } from "./gatewayHttpBase.js";
import { loadAttachmentPreviewSrc } from "./messageAttachments.js";

export interface GeneratedMediaPreviewData {
  kind: "image" | "video";
  localPath?: string;
  fileName?: string;
  mimeType?: string;
  appId?: string;
  appFileId?: string;
  modelId?: string;
  sizeBytes?: number;
}

export interface GeneratedMediaGalleryItem extends GeneratedMediaPreviewData {
  id: string;
  prompt?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseToolEnvelope(result: unknown): Record<string, unknown> | null {
  if (result == null) return null;
  let record: Record<string, unknown> | null = null;
  if (typeof result === "object") {
    record = result as Record<string, unknown>;
  } else if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  if (!record) return null;

  const data = record.data;
  if (typeof data === "object" && data !== null) {
    return data as Record<string, unknown>;
  }
  return record;
}

export function extractGeneratedMediaPreviewData(
  result: unknown,
): GeneratedMediaPreviewData | null {
  const data = parseToolEnvelope(result);
  if (!data) return null;

  const kindRaw = readString(data.kind);
  const kind = kindRaw === "video" ? "video" : kindRaw === "image" ? "image" : null;
  const localPath = readString(data.localPath);
  const appFileId = readString(data.appFileId);
  if (!kind || (!localPath && !appFileId)) {
    return null;
  }

  return {
    kind,
    localPath,
    fileName: readString(data.fileName),
    mimeType: readString(data.mimeType),
    appId: readString(data.appId),
    appFileId,
    modelId: readString(data.modelId),
    sizeBytes: readNumber(data.sizeBytes),
  };
}

function jobFilesUrl(localPath: string): string | null {
  const normalized = localPath.replace(/\\/g, "/");
  const match = normalized.match(/\/Jobs\/([^/]+)\/([^/]+)$/i);
  if (!match) return null;
  const [, jobId, fileName] = match;
  if (fileName.includes("..")) return null;
  return `${getGatewayHttpBase()}/api/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(fileName)}`;
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

function hasKnownExtension(fileName: string): boolean {
  return /\.[a-z0-9]{2,5}$/i.test(fileName);
}

/** Prefer artifact fileName; append mime extension when the stored name lacks one. */
export function resolveGeneratedMediaFileName(
  media: GeneratedMediaPreviewData,
): string | null {
  const raw =
    media.fileName?.trim() ||
    media.localPath?.replace(/\\/g, "/").split("/").pop()?.trim();
  if (!raw || raw.includes("..")) return null;

  if (hasKnownExtension(raw)) {
    return raw;
  }

  const defaultMime =
    media.mimeType ??
    (media.kind === "video" ? "video/mp4" : "image/png");
  return `${raw}.${extensionForMime(defaultMime)}`;
}

function generatedMediaUrlFromFileName(fileName: string): string {
  return `${getGatewayHttpBase()}/api/generated-media/${encodeURIComponent(fileName)}`;
}

function appFilesContentUrl(appId: string, appFileId: string): string {
  const base = getGatewayHttpBase();
  const params = new URLSearchParams({ appId, id: appFileId });
  return `${base}/api/files/content?${params.toString()}`;
}

export async function resolveGeneratedMediaPreviewSrc(
  media: GeneratedMediaPreviewData,
): Promise<string | null> {
  if (media.appId && media.appFileId) {
    return appFilesContentUrl(media.appId, media.appFileId);
  }

  if (media.localPath) {
    const normalized = media.localPath.replace(/\\/g, "/");
    const jobUrl = jobFilesUrl(media.localPath);
    if (jobUrl) {
      return jobUrl;
    }

    if (normalized.includes("/generated-media/") || media.fileName) {
      const fileName = resolveGeneratedMediaFileName(media);
      if (fileName) {
        return generatedMediaUrlFromFileName(fileName);
      }
    }

    if (media.kind === "image") {
      return loadAttachmentPreviewSrc(media.localPath, media.mimeType);
    }

    const readPreview = window.electronAPI?.chatAttachments?.readPreview;
    if (readPreview) {
      const preview = await readPreview({
        filePath: media.localPath,
        mimeType: media.mimeType ?? "video/mp4",
      });
      if (preview.success && preview.fileUrl) {
        return preview.fileUrl;
      }
    }
  }

  return null;
}

/** IPC/data-URL fallback when the gateway HTTP preview fails (e.g. legacy extensionless files). */
export async function resolveGeneratedMediaPreviewFallbackSrc(
  media: GeneratedMediaPreviewData,
): Promise<string | null> {
  if (!media.localPath) return null;

  if (media.kind === "image") {
    return loadAttachmentPreviewSrc(media.localPath, media.mimeType);
  }

  const readPreview = window.electronAPI?.chatAttachments?.readPreview;
  if (readPreview) {
    const preview = await readPreview({
      filePath: media.localPath,
      mimeType: media.mimeType ?? "video/mp4",
    });
    if (preview.success && preview.fileUrl) {
      return preview.fileUrl;
    }
  }

  return null;
}

export function formatGeneratedMediaSize(sizeBytes?: number): string | undefined {
  if (sizeBytes == null || sizeBytes <= 0) return undefined;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toolResultSucceeded(result: unknown): boolean {
  if (result == null) return false;
  if (typeof result === "object") {
    return (result as Record<string, unknown>).success !== false;
  }
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result) as Record<string, unknown>;
      return parsed.success !== false;
    } catch {
      return false;
    }
  }
  return false;
}

export function parseGeneratedMediaGalleryItem(input: {
  toolName: string;
  result?: unknown;
  status?: string;
  args?: Record<string, unknown>;
  fallbackId: string;
}): GeneratedMediaGalleryItem | null {
  if (input.toolName !== "generate_media") return null;
  if (
    input.status === "calling" ||
    input.status === "error" ||
    input.status === "interrupted"
  ) {
    return null;
  }
  if (!toolResultSucceeded(input.result)) return null;

  const data = extractGeneratedMediaPreviewData(input.result);
  if (!data) return null;

  const id =
    data.localPath ??
    (data.appFileId ? `${data.appId ?? "app"}:${data.appFileId}` : "") ??
    input.fallbackId;

  const prompt =
    typeof input.args?.prompt === "string" ? input.args.prompt.trim() : undefined;

  return {
    ...data,
    id,
    prompt: prompt && prompt.length > 0 ? prompt : undefined,
  };
}
