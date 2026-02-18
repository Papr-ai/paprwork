#!/usr/bin/env tsx

import { createReadStream } from "fs";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { v4 as uuidv4 } from "uuid";
import { LocalStorageProvider } from "../src/gateway/services/storage/LocalStorageProvider.js";
import type { StoredMessage } from "../src/gateway/services/storage/IStorageProvider.js";

interface LegacyMessage {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
}

interface LegacyChatIndexEntry {
  id?: unknown;
  title?: unknown;
}

interface LegacyIndexFile {
  chats?: unknown;
}

function parseLegacyIndex(raw: string): LegacyChatIndexEntry[] {
  const parsed = JSON.parse(raw) as LegacyIndexFile;
  if (!Array.isArray(parsed.chats)) {
    return [];
  }
  return parsed.chats.filter(
    (entry): entry is LegacyChatIndexEntry =>
      typeof entry === "object" && entry !== null,
  );
}

function toStoredMessage(chatId: string, message: LegacyMessage): StoredMessage | null {
  const role = message.role;
  const content = message.content;
  if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
    return null;
  }
  return {
    id: `msg-${uuidv4()}`,
    chat_id: chatId,
    role,
    content,
    timestamp:
      typeof message.timestamp === "string"
        ? message.timestamp
        : new Date().toISOString(),
    sync_status: "local",
  };
}

async function migrateChatFile(
  provider: LocalStorageProvider,
  sourceJsonlPath: string,
  chatId: string,
): Promise<number> {
  const stream = createReadStream(sourceJsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as LegacyMessage;
      const stored = toStoredMessage(chatId, parsed);
      if (!stored) {
        continue;
      }
      await provider.saveMessage(chatId, stored);
      count += 1;
    } catch {
      // Skip malformed lines.
    }
  }
  return count;
}

async function runMigration(): Promise<void> {
  const sourceRoot =
    process.argv[2] ??
    path.join(os.homedir(), "Documents", "GitHub", "paprwork", "chats");
  const indexPath = path.join(sourceRoot, "index.json");

  const v2DataPath = path.join(os.homedir(), ".paprwork-v2");
  const provider = new LocalStorageProvider(v2DataPath);
  await provider.initialize();

  let migratedChats = 0;
  let migratedMessages = 0;

  try {
    const indexRaw = await fs.readFile(indexPath, "utf8");
    const chats = parseLegacyIndex(indexRaw);
    for (const chat of chats) {
      const chatId =
        typeof chat.id === "string" && chat.id.length > 0 ? chat.id : uuidv4();
      const title = typeof chat.title === "string" ? chat.title : "Imported Chat";
      await provider.createChat(chatId, title);
      const sourceFile = path.join(sourceRoot, `${chatId}.jsonl`);
      try {
        await fs.access(sourceFile);
      } catch {
        continue;
      }
      const migratedInChat = await migrateChatFile(provider, sourceFile, chatId);
      migratedChats += 1;
      migratedMessages += migratedInChat;
      console.log(`[migrate:v1] ${chatId}: migrated ${migratedInChat} messages`);
    }
  } finally {
    provider.close();
  }

  console.log(
    `[migrate:v1] Complete. chats=${migratedChats}, messages=${migratedMessages}`,
  );
}

void runMigration();
