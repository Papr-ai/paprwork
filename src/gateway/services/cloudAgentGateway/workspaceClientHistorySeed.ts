import { randomUUID } from "crypto";
import { getAgentService } from "../AgentService.js";
import type { StoredMessage } from "../storage/IStorageProvider.js";

export interface ClientHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

function parseClientHistory(raw: string | undefined): ClientHistoryTurn[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const turns: ClientHistoryTurn[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const role = record.role;
      const content = record.content;
      if (role !== "user" && role !== "assistant") continue;
      if (typeof content !== "string" || !content.trim()) continue;
      turns.push({ role, content: content.trim() });
    }
    return turns;
  } catch {
    return [];
  }
}

/**
 * When Papr Web sends `clientHistory`, backfill chats.db if the warm sandbox is cold
 * or missing prior turns (gateway restart, session eviction, etc.).
 */
export async function seedWorkspaceChatHistoryFromClient(
  chatId: string,
  clientHistoryJson: string | undefined,
): Promise<void> {
  const clientTurns = parseClientHistory(clientHistoryJson);
  if (clientTurns.length === 0) return;

  const agentService = getAgentService();
  if (!agentService.isInitialized()) return;

  const storage = agentService.getStorageManager();
  const existing = await storage.loadMessagesForLLM(chatId);
  const existingCount = existing.filter(
    (msg) =>
      typeof msg === "object" &&
      msg !== null &&
      "role" in msg &&
      (msg.role === "user" || msg.role === "assistant"),
  ).length;

  if (existingCount >= clientTurns.length) {
    return;
  }

  const toWrite = clientTurns.slice(existingCount);
  if (toWrite.length === 0) return;

  console.log(
    `[CloudAgentGateway] Seeding ${toWrite.length} client history message(s) for ${chatId} ` +
      `(had ${existingCount}, client sent ${clientTurns.length})`,
  );

  const now = new Date().toISOString();
  for (const turn of toWrite) {
    const message: StoredMessage = {
      id: randomUUID(),
      chat_id: chatId,
      role: turn.role,
      content: turn.content,
      timestamp: now,
      sync_status: "local",
    };
    await storage.saveMessage(chatId, message);
  }
}
