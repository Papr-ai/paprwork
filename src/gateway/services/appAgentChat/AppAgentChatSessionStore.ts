/**
 * Session persistence for embedded app-agent chat.
 */

import { promises as fs } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import type {
  AppAgentChatMessage,
  AppAgentChatSession,
} from "../../../core/types/appAgentChat.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";

export interface AppAgentChatSessionStore {
  createSession(input: {
    appId: string;
    subAgentId: string;
  }): Promise<AppAgentChatSession>;
  getSession(sessionId: string): Promise<AppAgentChatSession | null>;
  appendMessage(
    sessionId: string,
    message: AppAgentChatMessage,
  ): Promise<AppAgentChatSession | null>;
  saveSession(session: AppAgentChatSession): Promise<void>;
}

function sessionsDir(): string {
  return path.join(getPaprRoot(), "data", "app-agent-sessions");
}

function sessionPath(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

export class FileAppAgentChatSessionStore implements AppAgentChatSessionStore {
  async createSession(input: {
    appId: string;
    subAgentId: string;
  }): Promise<AppAgentChatSession> {
    const now = new Date().toISOString();
    const session: AppAgentChatSession = {
      id: uuidv4(),
      appId: input.appId,
      subAgentId: input.subAgentId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.saveSession(session);
    return session;
  }

  async getSession(sessionId: string): Promise<AppAgentChatSession | null> {
    try {
      const raw = await fs.readFile(sessionPath(sessionId), "utf8");
      return JSON.parse(raw) as AppAgentChatSession;
    } catch {
      return null;
    }
  }

  async appendMessage(
    sessionId: string,
    message: AppAgentChatMessage,
  ): Promise<AppAgentChatSession | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }
    session.messages.push(message);
    session.updatedAt = new Date().toISOString();
    await this.saveSession(session);
    return session;
  }

  async saveSession(session: AppAgentChatSession): Promise<void> {
    const dir = sessionsDir();
    await fs.mkdir(dir, { recursive: true });
    const target = sessionPath(session.id);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(session, null, 2), "utf8");
    await fs.rename(tmp, target);
  }
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MEMORY_SESSIONS = 2000;

export class MemoryAppAgentChatSessionStore implements AppAgentChatSessionStore {
  private readonly sessions = new Map<string, AppAgentChatSession>();

  async createSession(input: {
    appId: string;
    subAgentId: string;
  }): Promise<AppAgentChatSession> {
    this.pruneExpired();
    const now = new Date().toISOString();
    const session: AppAgentChatSession = {
      id: uuidv4(),
      appId: input.appId,
      subAgentId: input.subAgentId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(sessionId: string): Promise<AppAgentChatSession | null> {
    this.pruneExpired();
    return this.sessions.get(sessionId) ?? null;
  }

  async appendMessage(
    sessionId: string,
    message: AppAgentChatMessage,
  ): Promise<AppAgentChatSession | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }
    session.messages.push(message);
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.id, session);
    return session;
  }

  async saveSession(session: AppAgentChatSession): Promise<void> {
    this.sessions.set(session.id, session);
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions.entries()) {
      const updatedMs = Date.parse(session.updatedAt);
      if (Number.isFinite(updatedMs) && updatedMs < cutoff) {
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size <= MAX_MEMORY_SESSIONS) {
      return;
    }
    const sorted = [...this.sessions.entries()].sort(
      (a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt),
    );
    const removeCount = this.sessions.size - MAX_MEMORY_SESSIONS;
    for (let i = 0; i < removeCount; i += 1) {
      const entry = sorted[i];
      if (entry) {
        this.sessions.delete(entry[0]);
      }
    }
  }
}

let fileStore: FileAppAgentChatSessionStore | null = null;
let memoryStore: MemoryAppAgentChatSessionStore | null = null;

export function getFileAppAgentChatSessionStore(): FileAppAgentChatSessionStore {
  if (!fileStore) {
    fileStore = new FileAppAgentChatSessionStore();
  }
  return fileStore;
}

export function getMemoryAppAgentChatSessionStore(): MemoryAppAgentChatSessionStore {
  if (!memoryStore) {
    memoryStore = new MemoryAppAgentChatSessionStore();
  }
  return memoryStore;
}
