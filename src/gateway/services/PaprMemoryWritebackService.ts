import Papr from "@papr/memory";
import { getApiKey } from "../utils/keyResolver.js";
import type { JobMemoryPolicy } from "./jobs/types.js";

export interface MemoryWritebackInput {
  content: string;
  policy: JobMemoryPolicy;
  sourceAgentId: string;
  sourceAgentName: string;
  runId: string;
  jobId: string;
  chatId?: string;
  externalUserId?: string;
}

function compactContent(input: MemoryWritebackInput): string {
  if (input.policy === "full") {
    return input.content;
  }
  return input.content.slice(0, 1000);
}

export async function writeRunMemory(input: MemoryWritebackInput): Promise<void> {
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
  await client.memory.add({
    content: compactContent(input),
    external_user_id: input.externalUserId,
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
}
