import Papr from "@papr/memory";
import { getApiKey } from "../utils/keyResolver.js";
import { getPaprUserId } from "../utils/paprUserId.js";
import type { JobMemoryPolicy } from "./jobs/types.js";

export interface MemoryWritebackInput {
  content: string;
  policy: JobMemoryPolicy;
  sourceAgentId: string;
  sourceAgentName: string;
  runId: string;
  jobId: string;
  chatId?: string;
  userId?: string;
}

function compactContent(input: MemoryWritebackInput): string {
  if (input.policy === "full") {
    return input.content;
  }
  return input.content.slice(0, 1000);
}

export async function writeRunMemory(
  input: MemoryWritebackInput,
): Promise<void> {
  if (input.policy === "none" || input.content.trim().length === 0) {
    return;
  }
  const apiKey = await getApiKey("PAPR_API_KEY");
  if (!apiKey) {
    return;
  }
  const client = new Papr({
    xAPIKey: apiKey,
    maxRetries: 2,
    timeout: 30000,
  });
  
  try {
    const userId = input.userId ?? getPaprUserId();
    await client.memory.add({
      content: compactContent(input),
      ...(userId ? { user_id: userId } : {}),
      metadata: {
        category: "learning",
        role: "assistant",
        customMetadata: {
          sourceAgentId: input.sourceAgentId,
          sourceAgentName: input.sourceAgentName,
          runId: input.runId,
          jobId: input.jobId,
          ...(input.chatId ? { chatId: input.chatId } : {}),
          writebackPolicy: input.policy,
        },
      },
    });
  } catch (error) {
    if (error instanceof Papr.RateLimitError || error instanceof Papr.PermissionDeniedError) {
      console.error(`[PaprMemoryWritebackService] Memory quota exceeded for job ${input.jobId}`);
      console.error(`[PaprMemoryWritebackService] Please upgrade your PAPR Memory account at: https://platform.papr.ai/settings`);
      throw new Error(
        "PAPR Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings to continue using memory features."
      );
    } else if (error instanceof Papr.AuthenticationError) {
      console.error(`[PaprMemoryWritebackService] Invalid PAPR API key`);
      throw new Error(
        "Invalid PAPR API key. Please check your Settings and ensure your API key is correct."
      );
    }
    throw error;
  }
}
