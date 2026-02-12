/**
 * Chat Service - Manages chat sessions and metadata
 *
 * Responsibilities:
 * - Create/delete chats
 * - List all chats
 * - Manage active chat
 * - Chat metadata (title, timestamp)
 * - Persist chat list
 */

import path from "path";
import fs from "fs/promises";
import os from "os";
import { v4 as uuidv4 } from "uuid";

export interface ChatMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export class ChatService {
  private chatsPath: string;
  private chats: Map<string, ChatMetadata>;
  private activeChat: string | null;

  constructor() {
    // Use home directory instead of Electron's app.getPath
    const homeDir = os.homedir();
    const userDataPath = path.join(homeDir, ".paprwork", "data");
    this.chatsPath = path.join(userDataPath, "chats.json");
    this.chats = new Map();
    this.activeChat = null;
  }

  /**
   * Initialize service and load chat list
   */
  async initialize(): Promise<void> {
    // Create data directory if it doesn't exist
    const dataDir = path.dirname(this.chatsPath);
    await fs.mkdir(dataDir, { recursive: true });

    await this.loadChats();
    console.log(`[ChatService] Initialized with ${this.chats.size} chats`);
  }

  /**
   * Create a new chat
   */
  async createChat(title?: string): Promise<ChatMetadata> {
    const chat: ChatMetadata = {
      id: uuidv4(),
      title: title || "New Chat",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    };

    this.chats.set(chat.id, chat);
    await this.saveChats();

    return chat;
  }

  /**
   * Delete a chat
   */
  async deleteChat(chatId: string): Promise<void> {
    if (!this.chats.has(chatId)) {
      throw new Error(`Chat not found: ${chatId}`);
    }

    this.chats.delete(chatId);

    // Clear active chat if deleted
    if (this.activeChat === chatId) {
      this.activeChat = null;
    }

    await this.saveChats();
  }

  /**
   * Get chat by ID
   */
  getChat(chatId: string): ChatMetadata | undefined {
    return this.chats.get(chatId);
  }

  /**
   * List all chats (sorted by updatedAt desc)
   */
  listChats(): ChatMetadata[] {
    const chats = Array.from(this.chats.values());
    return chats.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  /**
   * Update chat metadata
   */
  async updateChat(
    chatId: string,
    updates: Partial<Pick<ChatMetadata, "title" | "messageCount">>,
  ): Promise<ChatMetadata> {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }

    const updated: ChatMetadata = {
      ...chat,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.chats.set(chatId, updated);
    await this.saveChats();

    return updated;
  }

  /**
   * Set active chat
   */
  setActiveChat(chatId: string | null): void {
    if (chatId && !this.chats.has(chatId)) {
      throw new Error(`Chat not found: ${chatId}`);
    }
    this.activeChat = chatId;
  }

  /**
   * Get active chat ID
   */
  getActiveChat(): string | null {
    return this.activeChat;
  }

  /**
   * Generate chat title from first message
   */
  generateTitle(firstMessage: string): string {
    // Take first 50 chars, remove newlines
    let title = firstMessage.slice(0, 50).replace(/\n/g, " ").trim();

    if (firstMessage.length > 50) {
      title += "...";
    }

    return title || "New Chat";
  }

  /**
   * Auto-update chat title from first user message
   */
  async autoUpdateTitle(chatId: string, firstMessage: string): Promise<void> {
    const chat = this.chats.get(chatId);
    if (!chat) return;

    // Only update if still "New Chat"
    if (chat.title === "New Chat" && chat.messageCount === 0) {
      const title = this.generateTitle(firstMessage);
      await this.updateChat(chatId, { title, messageCount: 1 });
    }
  }

  /**
   * Load chats from disk
   */
  private async loadChats(): Promise<void> {
    try {
      const data = await fs.readFile(this.chatsPath, "utf8");
      const chatsArray = JSON.parse(data) as ChatMetadata[];

      this.chats.clear();
      for (const chat of chatsArray) {
        this.chats.set(chat.id, chat);
      }
    } catch (error) {
      // File doesn't exist or invalid JSON - start fresh
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[ChatService] Error loading chats:", error);
      }
    }
  }

  /**
   * Save chats to disk
   */
  private async saveChats(): Promise<void> {
    try {
      const chatsArray = Array.from(this.chats.values());
      const data = JSON.stringify(chatsArray, null, 2);

      // Ensure directory exists
      const dir = path.dirname(this.chatsPath);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(this.chatsPath, data, "utf8");
    } catch (error) {
      console.error("[ChatService] Error saving chats:", error);
    }
  }

  /**
   * Shutdown service
   */
  async shutdown(): Promise<void> {
    await this.saveChats();
    console.log("[ChatService] Shutting down");
  }
}

// Singleton instance
let chatServiceInstance: ChatService | null = null;

/**
 * Get or create ChatService singleton
 */
export function getChatService(): ChatService {
  if (!chatServiceInstance) {
    chatServiceInstance = new ChatService();
  }
  return chatServiceInstance;
}

/**
 * Initialize ChatService (call on app ready)
 */
export async function initializeChatService(): Promise<ChatService> {
  const service = getChatService();
  await service.initialize();
  return service;
}
