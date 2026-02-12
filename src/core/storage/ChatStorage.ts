/**
 * Chat storage manager - Handles persistence of chat messages
 * File-based JSONL storage for reliability and simplicity
 */

import * as fs from "fs/promises";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import type {
  CoreMessage,
  PersistedMessage,
  CompactionEntry,
  StorageEntry,
  IStorageManager,
} from "../types/index.js";

export class ChatStorage implements IStorageManager {
  private chatsDir: string;

  constructor(userDataPath: string) {
    this.chatsDir = path.join(userDataPath, "chats");
  }

  /**
   * Initialize storage (create directories)
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.chatsDir, { recursive: true });
  }

  /**
   * Save a message to chat history
   */
  async saveMessage(chatId: string, message: CoreMessage): Promise<void> {
    const chatPath = this.getChatPath(chatId);

    const persistedMessage: PersistedMessage = {
      id: uuidv4(),
      role: message.role,
      content: message.content,
      timestamp: new Date().toISOString(),
    };

    // Append to JSONL file
    const line = JSON.stringify(persistedMessage) + "\n";
    await fs.appendFile(chatPath, line, "utf-8");
  }

  /**
   * Load all messages for a chat
   */
  async loadMessages(chatId: string): Promise<PersistedMessage[]> {
    const chatPath = this.getChatPath(chatId);

    try {
      const content = await fs.readFile(chatPath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim());

      const entries: StorageEntry[] = lines.map((line) => JSON.parse(line));

      // Filter out compaction entries, return only messages
      return entries.filter((entry): entry is PersistedMessage => {
        return "role" in entry;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Chat doesn't exist yet
        return [];
      }
      throw error;
    }
  }

  /**
   * Save a compaction entry
   */
  async saveCompaction(
    chatId: string,
    compaction: CompactionEntry,
  ): Promise<void> {
    const chatPath = this.getChatPath(chatId);
    const line = JSON.stringify(compaction) + "\n";
    await fs.appendFile(chatPath, line, "utf-8");
  }

  /**
   * Rewrite chat file with new messages (after compaction)
   */
  async rewriteChat(chatId: string, entries: StorageEntry[]): Promise<void> {
    const chatPath = this.getChatPath(chatId);
    const content =
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await fs.writeFile(chatPath, content, "utf-8");
  }

  /**
   * Delete a chat
   */
  async deleteChat(chatId: string): Promise<void> {
    const chatPath = this.getChatPath(chatId);
    try {
      await fs.unlink(chatPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  /**
   * List all chat IDs
   */
  async listChats(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.chatsDir);
      return files
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => path.basename(file, ".jsonl"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get path to chat file
   */
  private getChatPath(chatId: string): string {
    return path.join(this.chatsDir, `${chatId}.jsonl`);
  }
}
