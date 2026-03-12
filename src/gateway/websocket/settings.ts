/**
 * Settings WebSocket Handlers
 *
 * Persists profile and permission settings to a JSON file.
 * Gateway runs as a separate process, so we use a simple file store
 * rather than electron-store (which requires the Electron main process).
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendResponse, sendError } from "./index.js";
import { createReadStream, promises as fs } from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { v4 as uuidv4 } from "uuid";

interface ProfileData {
  name: string;
  email: string;
  imageUrl: string;
}

interface PermissionData {
  fileSystem: boolean;
  network: boolean;
  calendar: boolean;
}

interface CodeIndexingSettings {
  enabled: boolean;
  excludedFolders: string[]; // Folders to exclude from indexing (e.g., "papr_repo")
}

interface UIPreferences {
  lastModelId: string | null; // Last selected model
  onboardingDismissed: boolean; // Whether onboarding was dismissed
  onboardingStep1Completed: boolean; // Configure API keys
  onboardingStep2Completed: boolean; // Setup your agents
  onboardingStep3Completed: boolean; // Complete first task
}

interface SettingsData {
  profile: ProfileData;
  permissions: PermissionData;
  codeIndexing: CodeIndexingSettings;
  uiPreferences: UIPreferences;
}

const DEFAULTS: SettingsData = {
  profile: { name: "", email: "", imageUrl: "" },
  permissions: { fileSystem: true, network: true, calendar: false },
  codeIndexing: {
    enabled: true,
    excludedFolders: [
      "papr_repo",      // Cloned repositories
      "node_modules",   // NPM dependencies
      ".venv",          // Python virtual environments
      "venv",
      ".git",           // Git history
      "dist",           // Build outputs
      "build",
      "__pycache__",    // Python cache
      ".next",          // Next.js build
      ".nuxt",          // Nuxt build
    ],
  },
  uiPreferences: {
    lastModelId: null,
    onboardingDismissed: false,
    onboardingStep1Completed: false,
    onboardingStep2Completed: false,
    onboardingStep3Completed: false,
  },
};

const SETTINGS_PATH = path.join(os.homedir(), "PAPR", "data", "settings.json");

export async function loadSettings(): Promise<SettingsData> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

async function saveSettings(data: SettingsData): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export async function setupSettingsHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    switch (message.type) {
      case "settings:get": {
        const settings = await loadSettings();
        sendResponse(ws, { id: message.id, success: true, data: settings });
        break;
      }

      case "settings:save-profile": {
        const payload = message.payload as Partial<ProfileData>;
        const settings = await loadSettings();
        settings.profile = { ...settings.profile, ...payload };
        await saveSettings(settings);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: settings.profile,
        });
        break;
      }

      case "settings:save-permissions": {
        const payload = message.payload as Partial<PermissionData>;
        const settings = await loadSettings();
        settings.permissions = { ...settings.permissions, ...payload };
        await saveSettings(settings);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: settings.permissions,
        });
        break;
      }

      case "settings:save-code-indexing": {
        const payload = message.payload as Partial<CodeIndexingSettings>;
        const settings = await loadSettings();
        settings.codeIndexing = { ...settings.codeIndexing, ...payload };
        await saveSettings(settings);
        
        // If indexing was toggled or excluded folders changed, notify CodeIndexingService
        // TODO: Add hot reload for code indexing config
        
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: settings.codeIndexing,
        });
        break;
      }

      case "settings:save-ui-preferences": {
        const payload = message.payload as Partial<UIPreferences>;
        const settings = await loadSettings();
        settings.uiPreferences = { ...settings.uiPreferences, ...payload };
        await saveSettings(settings);
        
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: settings.uiPreferences,
        });
        break;
      }

      case "settings:migrate-v1": {
        const result = await runV1Migration(ws, message.id);
        sendResponse(ws, { id: message.id, success: true, data: result });
        break;
      }

      default:
        sendError(
          ws,
          message.id,
          `Unknown settings message type: ${message.type}`,
        );
    }
  } catch (error) {
    console.error("[Settings WS] Error:", error);
    sendError(ws, message.id, error as Error);
  }
}

// ===== V1 Migration =====

interface MigrationResult {
  chats: { migrated: number; messages: number };
  documents: { migrated: number };
  apps: { migrated: number };
}

interface LegacyMessage {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
}

interface LegacyChatIndexEntry {
  id?: unknown;
  title?: unknown;
}

interface LegacyDocument {
  id?: string;
  title?: string;
  content?: string;
  createdAt?: string;
  updatedAt?: string;
  favorite?: boolean;
  tags?: string[];
}

interface LegacyApp {
  id?: string;
  name?: string;
  description?: string;
  createdAt?: string;
}

async function runV1Migration(
  _ws: WebSocket,
  _messageId: string,
): Promise<MigrationResult> {
  const v1Root = path.join(os.homedir(), ".paprwork");
  const v2Root = path.join(os.homedir(), "PAPR");
  const result: MigrationResult = {
    chats: { migrated: 0, messages: 0 },
    documents: { migrated: 0 },
    apps: { migrated: 0 },
  };

  // --- 1. Migrate chats ---
  const chatIndexPath = path.join(v1Root, "chats", "index.json");
  try {
    const raw = await fs.readFile(chatIndexPath, "utf-8");
    const parsed = JSON.parse(raw) as { chats?: LegacyChatIndexEntry[] };
    const chats = Array.isArray(parsed.chats) ? parsed.chats : [];

    const v2ChatsDir = path.join(v2Root, "data", "chats");
    await fs.mkdir(v2ChatsDir, { recursive: true });

    for (const chat of chats) {
      const chatId =
        typeof chat.id === "string" && chat.id.length > 0 ? chat.id : uuidv4();
      const title =
        typeof chat.title === "string" ? chat.title : "Imported Chat";

      const sourceFile = path.join(v1Root, "chats", `${chatId}.jsonl`);
      try {
        await fs.access(sourceFile);
      } catch {
        continue;
      }

      // Create V2 chat directory
      const chatDir = path.join(v2ChatsDir, chatId);
      await fs.mkdir(chatDir, { recursive: true });

      // Write meta
      await fs.writeFile(
        path.join(chatDir, "meta.json"),
        JSON.stringify(
          { id: chatId, title, createdAt: new Date().toISOString() },
          null,
          2,
        ),
      );

      // Copy messages
      const stream = createReadStream(sourceFile, { encoding: "utf8" });
      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      });
      const messages: string[] = [];

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as LegacyMessage;
          if (
            (msg.role === "user" || msg.role === "assistant") &&
            typeof msg.content === "string"
          ) {
            messages.push(
              JSON.stringify({
                id: `msg-${uuidv4()}`,
                chat_id: chatId,
                role: msg.role,
                content: msg.content,
                timestamp:
                  typeof msg.timestamp === "string"
                    ? msg.timestamp
                    : new Date().toISOString(),
                sync_status: "local",
              }),
            );
          }
        } catch {
          // skip malformed
        }
      }

      if (messages.length > 0) {
        await fs.writeFile(
          path.join(chatDir, "messages.jsonl"),
          messages.join("\n") + "\n",
        );
        result.chats.messages += messages.length;
      }
      result.chats.migrated += 1;
    }
  } catch (err) {
    console.log(
      "[Migration] No V1 chat index found or error:",
      (err as Error).message,
    );
  }

  // --- 2. Migrate documents ---
  const docsJsonPath = path.join(v1Root, "data", "documents.json");
  try {
    const raw = await fs.readFile(docsJsonPath, "utf-8");
    const docs = JSON.parse(raw) as LegacyDocument[];
    const v2DocsDir = path.join(v2Root, "documents");

    for (const doc of docs) {
      if (!doc.id) continue;

      const docDir = path.join(v2DocsDir, doc.id);
      await fs.mkdir(docDir, { recursive: true });

      // Write content.md
      await fs.writeFile(
        path.join(docDir, "content.md"),
        doc.content ?? "",
        "utf-8",
      );

      // Write meta.json
      const meta = {
        title: doc.title ?? "Untitled",
        tags: doc.tags ?? [],
        favorite: doc.favorite ?? false,
        createdAt: doc.createdAt ?? new Date().toISOString(),
        updatedAt: doc.updatedAt ?? new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(docDir, "meta.json"),
        JSON.stringify(meta, null, 2),
        "utf-8",
      );

      // Create versions dir
      await fs.mkdir(path.join(docDir, "versions"), { recursive: true });

      result.documents.migrated += 1;
    }
  } catch (err) {
    console.log(
      "[Migration] No V1 documents found or error:",
      (err as Error).message,
    );
  }

  // --- 3. Migrate apps ---
  const appsJsonPath = path.join(v1Root, "data", "apps.json");
  try {
    const raw = await fs.readFile(appsJsonPath, "utf-8");
    const apps = JSON.parse(raw) as LegacyApp[];
    const v2AppsDir = path.join(v2Root, "apps");

    for (const app of apps) {
      if (!app.id) continue;

      const appDir = path.join(v2AppsDir, app.id);
      await fs.mkdir(appDir, { recursive: true });

      // Write index.json
      const appMeta = {
        id: app.id,
        name: app.name ?? "Untitled App",
        description: app.description ?? "",
        createdAt: app.createdAt ?? new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(appDir, "index.json"),
        JSON.stringify(appMeta, null, 2),
        "utf-8",
      );

      // Copy app files from V1 if they exist
      const v1AppDir = path.join(v1Root, "apps", app.id);
      try {
        const entries = await fs.readdir(v1AppDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            await fs.copyFile(
              path.join(v1AppDir, entry.name),
              path.join(appDir, entry.name),
            );
          }
        }
      } catch {
        // V1 app dir may not exist
      }

      result.apps.migrated += 1;
    }
  } catch (err) {
    console.log(
      "[Migration] No V1 apps found or error:",
      (err as Error).message,
    );
  }

  console.log(
    `[Migration] Complete: ${result.chats.migrated} chats (${result.chats.messages} msgs), ` +
      `${result.documents.migrated} docs, ${result.apps.migrated} apps`,
  );

  return result;
}
