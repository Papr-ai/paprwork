import { gateway } from "../src/lib/gateway";

const inflightHistoryRequests = new Map<string, Promise<unknown[]>>();

export async function fetchChatHistory(chatId: string): Promise<unknown[]> {
  const existing = inflightHistoryRequests.get(chatId);
  if (existing) {
    return existing;
  }

  const request = (async () => {
    const response = await gateway.send("agent:history", { chatId });
    const data = response.data;
    return Array.isArray(data) ? data : [];
  })();

  inflightHistoryRequests.set(chatId, request);
  try {
    return await request;
  } finally {
    inflightHistoryRequests.delete(chatId);
  }
}
