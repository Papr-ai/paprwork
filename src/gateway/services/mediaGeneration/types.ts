import type { MediaAuthKind } from "./mediaAuth.js";

export type MediaKind = "image" | "video";

export type MediaProviderId = "google" | "openai";

export type MediaApiStyle =
  | "gemini_generate_content"
  | "veo_predict_long_running"
  | "openai_images"
  | "openai_codex_image";

export interface MediaModelDefinition {
  id: string;
  label: string;
  kind: MediaKind;
  provider: MediaProviderId;
  apiStyle: MediaApiStyle;
  /** Remote model id passed to the provider API. */
  remoteModel: string;
  /** Platform image model for Codex OAuth (openai_codex_image only). */
  codexImageModel?: string;
  implemented: boolean;
  unavailableReason?: string;
  defaultAspectRatio?: string;
  supportedAspectRatios?: readonly string[];
  /** Veo-only: default clip length in seconds. */
  defaultDurationSeconds?: number;
}

export interface ResolvedMediaModel extends MediaModelDefinition {
  authKind: MediaAuthKind;
  apiKey?: string;
  oauthToken?: string;
  oauthAccountId?: string;
}

export interface GenerateMediaInput {
  prompt: string;
  modelId: string;
  aspectRatio?: string;
  durationSeconds?: number;
  appId?: string;
  fileName?: string;
  referenceImagePath?: string;
}

export interface GeneratedMediaArtifact {
  modelId: string;
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  localPath: string;
  fileName: string;
  appId?: string;
  appFileId?: string;
  sha256Prefix: string;
  authPath?: string;
}

export interface ListMediaModelsResult {
  available: Array<{
    id: string;
    label: string;
    kind: MediaKind;
    provider: MediaProviderId;
    authPath?: string;
    defaultAspectRatio?: string;
    supportedAspectRatios?: readonly string[];
  }>;
  unavailable: Array<{
    id: string;
    label: string;
    kind: MediaKind;
    reason: string;
  }>;
}
