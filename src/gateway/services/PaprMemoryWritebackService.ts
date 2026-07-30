/**
 * Optional text log writeback for agent/subagent jobs (memoryPolicy summary/full).
 * Structured job output in data.db is synced separately via JobDatabaseMemorySync.
 */
import Papr from "@papr/memory";
import { handlePaprToolError } from "../../core/tools/paprClient.js";
import { getApiKey } from "../utils/keyResolver.js";
import { paprMemoryScopeSpread } from "../utils/memoryScopeResolver.js";
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
    const memoryScope = await paprMemoryScopeSpread({
      chatId: input.chatId,
    });
    await client.memory.add({
      content: compactContent(input),
      ...(input.userId && !memoryScope.external_user_id
        ? { external_user_id: input.userId }
        : memoryScope),
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
    if (error instanceof Papr.AuthenticationError) {
      console.error(`[PaprMemoryWritebackService] Invalid PAPR API key`);
    }
    handlePaprToolError(error, "job-memory-writeback");
  }
}
