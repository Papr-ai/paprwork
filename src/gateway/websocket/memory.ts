/**
 * WebSocket handlers for memory operations
 * - Workspace file operations
 * - Folder opening
 * - Memory statistics
 * - Schema listing for UI
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendResponse, sendError } from "./index.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const PAPR_DIR = path.join(os.homedir(), "Papr");
const WORKSPACE_DIR = path.join(PAPR_DIR, "workspace");
const WORKSPACE_FILE = path.join(WORKSPACE_DIR, "workspace.md");

export async function setupMemoryHandlers(
  ws: WebSocket,
  message: WSMessage
): Promise<void> {
  try {
    if (message.type === "memory:get-workspace") {
      await handleGetWorkspace(ws, message);
    } else if (message.type === "memory:save-workspace") {
      await handleSaveWorkspace(ws, message);
    } else if (message.type === "memory:open-folder") {
      await handleOpenFolder(ws, message);
    } else if (message.type === "memory:chat-stats") {
      await handleChatStats(ws, message);
    } else if (message.type === "memory:list-workspace-files") {
      await handleListWorkspaceFiles(ws, message);
    } else if (message.type === "memory:list-schemas") {
      await handleListSchemas(ws, message);
    } else {
      sendError(ws, message.id, `Unknown memory message type: ${message.type}`);
    }
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

/**
 * Get workspace.md content
 */
async function handleGetWorkspace(
  ws: WebSocket,
  message: WSMessage
): Promise<void> {
  try {
    // Ensure workspace directory exists
    if (!fs.existsSync(WORKSPACE_DIR)) {
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    }

    // Read or create workspace.md
    let content = "";
    if (fs.existsSync(WORKSPACE_FILE)) {
      content = fs.readFileSync(WORKSPACE_FILE, "utf-8");
    } else {
      // Create default workspace.md
      content = `# Workspace Context

This file helps AI agents understand your current work context.

## Current Focus


## Active Projects


## Notes

`;
      fs.writeFileSync(WORKSPACE_FILE, content, "utf-8");
    }

    sendResponse(ws, {
      id: message.id,
      success: true,
      data: { content, path: WORKSPACE_FILE },
    });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

/**
 * Save workspace.md content
 */
async function handleSaveWorkspace(
  ws: WebSocket,
  message: WSMessage
): Promise<void> {
  try {
    const { content } = message.payload as { content: string };

    if (!content || typeof content !== "string") {
      throw new Error("Invalid content: must be a string");
    }

    // Ensure workspace directory exists
    if (!fs.existsSync(WORKSPACE_DIR)) {
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    }

    // Write content
    fs.writeFileSync(WORKSPACE_FILE, content, "utf-8");

    sendResponse(ws, {
      id: message.id,
      success: true,
      data: { saved: true, path: WORKSPACE_FILE },
    });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

/**
 * Open folder in system file explorer
 */
async function handleOpenFolder(
  ws: WebSocket,
  message: WSMessage
): Promise<void> {
  try {
    const { folderPath } = message.payload as { folderPath: string };

    if (!folderPath) {
      throw new Error("folderPath is required");
    }

    // Resolve ~ to home directory
    const resolvedPath = folderPath.startsWith("~")
      ? path.join(os.homedir(), folderPath.slice(1))
      : folderPath;

    // Ensure folder exists
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Folder does not exist: ${resolvedPath}`);
    }

    // Open folder based on platform
    let command: string;
    if (process.platform === "darwin") {
      command = `open "${resolvedPath}"`;
    } else if (process.platform === "win32") {
      command = `explorer "${resolvedPath}"`;
    } else {
      // Linux
      command = `xdg-open "${resolvedPath}"`;
    }

    await execAsync(command);

    sendResponse(ws, {
      id: message.id,
      success: true,
      data: { opened: true, path: resolvedPath },
    });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

/**
 * Get chat memory statistics
 */
async function handleChatStats(
  ws: WebSocket,
  message: WSMessage
): Promise<void> {
  try {
    // TODO: Query chats.db for statistics
    // For now, return mock data
    const stats: {
      total_conversations: number;
      total_messages: number;
      last_indexed_at: string | null;
    } = {
      total_conversations: 0,
      total_messages: 0,
      last_indexed_at: null,
    };

    const chatsDbPath = path.join(os.homedir(), ".paprwork-v2", "chats.db");
    if (fs.existsSync(chatsDbPath)) {
      try {
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(chatsDbPath, { readonly: true });

        // Count conversations
        const conversationsRow = db
          .prepare("SELECT COUNT(DISTINCT chat_id) as count FROM messages")
          .get() as { count: number };
        stats.total_conversations = conversationsRow.count;

        // Count messages
        const messagesRow = db
          .prepare("SELECT COUNT(*) as count FROM messages")
          .get() as { count: number };
        stats.total_messages = messagesRow.count;

        // Get last indexed (most recent message timestamp)
        const lastRow = db
          .prepare(
            "SELECT MAX(timestamp) as last_timestamp FROM messages"
          )
          .get() as { last_timestamp: string | null };
        if (lastRow.last_timestamp) {
          stats.last_indexed_at = lastRow.last_timestamp;
        }

        db.close();
      } catch (dbError) {
        console.error("[Memory] Failed to query chats.db:", dbError);
      }
    }

    sendResponse(ws, {
      id: message.id,
      success: true,
      data: stats,
    });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

/**
 * List all .md files in workspace directory
 */
async function handleListWorkspaceFiles(
  ws: WebSocket,
  message: WSMessage
): Promise<void> {
  try {
    // Ensure workspace directory exists
    if (!fs.existsSync(WORKSPACE_DIR)) {
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    }

    // Read all .md files
    const files = fs
      .readdirSync(WORKSPACE_DIR)
      .filter((file) => file.endsWith(".md"))
      .sort();

    sendResponse(ws, {
      id: message.id,
      success: true,
      data: { files },
    });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

/**
 * List Papr Memory schemas for the current namespace
 */
async function handleListSchemas(
  ws: WebSocket,
  message: WSMessage
): Promise<void> {
  try {
    const { getApiKey } = await import("../../gateway/utils/keyResolver.js");
    const apiKey = await getApiKey("PAPR_API_KEY");

    if (!apiKey) {
      sendResponse(ws, {
        id: message.id,
        success: true,
        data: { schemas: [], error: "No PAPR_API_KEY configured" },
      });
      return;
    }

    const Papr = (await import("@papr/memory")).default;
    const client = new Papr({ xAPIKey: apiKey, maxRetries: 1, timeout: 15000 });

    const payload = message.payload as { statusFilter?: string } | undefined;
    const response = await client.schemas.list({
      status_filter: payload?.statusFilter as "draft" | "active" | "deprecated" | "archived" | undefined,
    });

    const responseData = response as { data?: Array<{
      id?: string;
      name?: string;
      description?: string;
      status?: string;
      version?: string;
      node_types?: Array<{ name?: string }> | Record<string, unknown>;
      relationship_types?: Array<{ name?: string }> | Record<string, unknown>;
    }> };

    const schemas = (responseData.data ?? []).map((schema) => {
      const nodeTypes = Array.isArray(schema.node_types)
        ? schema.node_types.map((nt) => nt.name).filter(Boolean)
        : Object.keys(schema.node_types ?? {});
      const relTypes = Array.isArray(schema.relationship_types)
        ? schema.relationship_types.map((rt) => rt.name).filter(Boolean)
        : Object.keys(schema.relationship_types ?? {});

      return {
        id: schema.id,
        name: schema.name,
        description: schema.description,
        status: schema.status,
        version: schema.version,
        nodeTypeCount: nodeTypes.length,
        relationshipTypeCount: relTypes.length,
        nodeTypeNames: nodeTypes,
        relationshipTypeNames: relTypes,
      };
    });

    sendResponse(ws, {
      id: message.id,
      success: true,
      data: { schemas },
    });
  } catch (error) {
    console.error("[Memory] Failed to list schemas:", error);
    sendResponse(ws, {
      id: message.id,
      success: true,
      data: { schemas: [], error: error instanceof Error ? error.message : "Failed to list schemas" },
    });
  }
}
