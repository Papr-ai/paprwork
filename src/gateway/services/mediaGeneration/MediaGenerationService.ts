import { loadMediaAuthContext } from "./mediaAuth.js";
import { listMediaModels, resolveMediaModel } from "./models.js";
import { generateMediaBytes } from "./providers.js";
import { persistGeneratedMedia } from "./storage.js";
import type {
  GenerateMediaInput,
  GeneratedMediaArtifact,
  ListMediaModelsResult,
} from "./types.js";

export async function listAvailableMediaModels(): Promise<ListMediaModelsResult> {
  const ctx = await loadMediaAuthContext();
  return listMediaModels(ctx);
}

export async function generateMedia(
  input: GenerateMediaInput,
  options?: { jobDir?: string },
): Promise<GeneratedMediaArtifact> {
  const ctx = await loadMediaAuthContext();
  const resolved = resolveMediaModel(input.modelId, ctx);
  if (!resolved.model) {
    throw new Error(resolved.error ?? `Model "${input.modelId}" is unavailable.`);
  }

  const generated = await generateMediaBytes({
    model: resolved.model,
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    durationSeconds: input.durationSeconds,
    referenceImagePath: input.referenceImagePath,
  });

  const artifact = await persistGeneratedMedia({
    bytes: generated.bytes,
    mimeType: generated.mimeType,
    suggestedExtension: generated.suggestedExtension,
    modelId: resolved.model.id,
    kind: resolved.model.kind,
    fileName: input.fileName,
    appId: input.appId,
    jobDir: options?.jobDir,
  });

  return {
    ...artifact,
    authPath:
      resolved.model.authKind === "openai_oauth"
        ? "ChatGPT OAuth (Codex)"
        : resolved.model.authKind === "openai_platform"
          ? "OpenAI Platform API key"
          : "Google API key",
  };
}

export async function resolveAppIdForMediaJob(
  explicitAppId: string | undefined,
  chatId: string | null,
): Promise<string | undefined> {
  if (explicitAppId?.trim()) {
    return explicitAppId.trim();
  }

  const jobMatch = chatId?.match(/^job:([^:]+):/);
  if (!jobMatch) {
    return undefined;
  }

  const { getJobsService } = await import("../JobsService.js");
  const jobsService = getJobsService();
  await jobsService.initialize();
  const job = await jobsService.getJob(jobMatch[1]);
  const linked = (job?.appIds ?? []).find((id) => id !== "__standalone__");
  return linked;
}
