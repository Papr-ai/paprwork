import { gateway } from "../src/lib/gateway";

const inflightHistoryRequests = new Map<string, Promise<unknown[]>>();

export interface FetchChatHistoryOptions {
  limit?: number;
  skip?: number;
}

export function getRemainingHistoryBatchSize(input: {
  loadedMessageCount: number;
  knownMessageCount?: number;
  minimumBatchSize?: number;
}): number {
  const minimum = input.minimumBatchSize ?? 20;
  if (input.knownMessageCount === undefined) return minimum;
  return Math.max(minimum, input.knownMessageCount - input.loadedMessageCount);
}

export async function fetchChatHistory(
  chatId: string,
  options: FetchChatHistoryOptions = {}
): Promise<unknown[]> {
  const requestKey = `${chatId}-${options.limit || 'all'}-${options.skip || 0}`;
  const existing = inflightHistoryRequests.get(requestKey);
  if (existing) {
    return existing;
  }

  const request = (async () => {
    const response = await gateway.send("agent:history", { 
      chatId,
      limit: options.limit,
      skip: options.skip
    });
    const data = response.data;
    return Array.isArray(data) ? data : [];
  })();

  inflightHistoryRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    inflightHistoryRequests.delete(requestKey);
  }
}
