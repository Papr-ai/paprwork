/**
 * WebSocket handlers for memory operations
 * - Workspace file operations
 * - Folder opening
 * - Memory statistics
 * - Schema listing for UI
 */

import type { WebSocket } from "ws";
import { getPaprRoot, getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";
import { resolvePaprAgentPath } from "../../core/utils/paprAgentPaths.js";
import { resolvePaprUserDataPath } from "../../core/utils/paprWorkspace.js";
import type { WSMessage } from "./index.js";
import { sendResponse, sendError } from "./index.js";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

function workspaceDir(): string {
  return getPaprWorkspaceDir();
}
function workspaceFile(): string {
  return path.join(getPaprWorkspaceDir(), "workspace.md");
}
function workspaceMemoryDir(): string {
  return path.join(getPaprWorkspaceDir(), "memory");
}

const WRITABLE_WORKSPACE_FILES = new Set([
  "MEMORY.md",
  "IDENTITY.md",
  "AGENTS.md",
  "TOOLS.md",
  "BRAND.md",
  "ONBOARD.md",
  "SLEEP.md",
]);

const MAX_CONTEXT_FILE_BYTES = 512_000;

function resolveContextFilePath(fileName: string): string | null {
  const memoryMatch = fileName.match(/^memory\/(\d{4}-\d{2}-\d{2}\.md)/);
  if (memoryMatch) {
    return path.join(workspaceMemoryDir(), memoryMatch[1]);
  }

  const baseName = path.basename(fileName.split(" (")[0] ?? fileName);
  if (!baseName.endsWith(".md")) {
    return null;
  }

  const workspacePath = path.join(workspaceDir(), baseName);
  if (fs.existsSync(workspacePath)) {
    return workspacePath;
  }

  return null;
}

function resolveContextFilePathForWrite(fileName: string): string | null {
  const existing = resolveContextFilePath(fileName);
  if (existing) {
    return existing;
  }

  const memoryMatch = fileName.match(/^memory\/(\d{4}-\d{2}-\d{2}\.md)/);
  if (memoryMatch) {
    return path.join(workspaceMemoryDir(), memoryMatch[1]);
  }

  const baseName = path.basename(fileName.split(" (")[0] ?? fileName);
  if (WRITABLE_WORKSPACE_FILES.has(baseName)) {
    return path.join(workspaceDir(), baseName);
  }

  return null;
}

function assertPathUnderWorkspace(filePath: string): void {
  const workspaceRoot = path.resolve(workspaceDir());
  const resolved = path.resolve(filePath);
  if (
    resolved !== workspaceRoot &&
    !resolved.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    throw new Error("Path is outside workspace directory");
  }
}

export async function setupMemoryHandlers(
  ws: WebSocket,
  message: WSMessage,
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
    } else if (message.type === "memory:get-context-preview") {
      await handleGetContextPreview(ws, message);
    } else if (message.type === "memory:read-context-file") {
      await handleReadContextFile(ws, message);
    } else if (message.type === "memory:write-context-file") {
      await handleWriteContextFile(ws, message);
    } else if (message.type === "memory:upload-attachment") {
      await handleUploadAttachment(ws, message);
    } else if (message.type === "memory:wiki-home") {
      await handleWikiHome(ws, message);
    } else if (message.type === "memory:wiki-entity") {
      await handleWikiEntity(ws, message);
    } else if (message.type === "memory:wiki-search") {
      await handleWikiSearch(ws, message);
    } else if (message.type === "memory:wiki-create-entity") {
      await handleWikiCreateEntity(ws, message);
    } else if (message.type === "memory:wiki-add-type") {
      await handleWikiAddType(ws, message);
    } else if (message.type === "memory:wiki-update-media") {
      await handleWikiUpdateMedia(ws, message);
    } else if (message.type === "memory:wiki-toggle-open-item") {
      await handleWikiToggleOpenItem(ws, message);
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
  message: WSMessage,
): Promise<void> {
  try {
    // Ensure workspace directory exists
    if (!fs.existsSync(workspaceDir())) {
      fs.mkdirSync(workspaceDir(), { recursive: true });
    }

    // Read or create workspace.md
    let content = "";
    if (fs.existsSync(workspaceFile())) {
      content = fs.readFileSync(workspaceFile(), "utf-8");
    } else {
      // Create default workspace.md
      content = `# Workspace Context

This file helps AI agents understand your current work context.

## Current Focus


## Active Projects


## Notes

`;
      fs.writeFileSync(workspaceFile(), content, "utf-8");
    }

    sendResponse(ws, {
      id: message.id,
      success: true,
      data: { content, path: workspaceFile() },
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
  message: WSMessage,
): Promise<void> {
  try {
    const { content } = message.payload as { content: string };

    if (!content || typeof content !== "string") {
      throw new Error("Invalid content: must be a string");
    }

    // Ensure workspace directory exists
    if (!fs.existsSync(workspaceDir())) {
      fs.mkdirSync(workspaceDir(), { recursive: true });
    }

    // Write content
    fs.writeFileSync(workspaceFile(), content, "utf-8");

    sendResponse(ws, {
      id: message.id,
      success: true,
      data: { saved: true, path: workspaceFile() },
    });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

type MemoryOpenFolderTarget = "workspace" | "paprHome";

interface MemoryOpenFolderPayload {
  folderPath?: string;
  /** Prefer target — resolves active org/namespace paths on the gateway. */
  target?: MemoryOpenFolderTarget;
}

/**
 * Open folder in system file explorer
 */
async function handleOpenFolder(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    const { folderPath, target } = message.payload as MemoryOpenFolderPayload;

    let resolvedPath: string;
    if (target === "workspace") {
      resolvedPath = workspaceDir();
    } else if (target === "paprHome") {
      resolvedPath = getPaprRoot();
    } else if (folderPath) {
      // Rewrite legacy ~/Papr/apps|Jobs|workspace|… to active org/namespace roots
      resolvedPath = resolvePaprAgentPath(folderPath);
    } else {
      throw new Error("folderPath or target is required");
    }

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
  message: WSMessage,
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

    const chatsDbPath = path.join(resolvePaprUserDataPath(), "chats.db");
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
          .prepare("SELECT MAX(timestamp) as last_timestamp FROM messages")
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
  message: WSMessage,
): Promise<void> {
  try {
    // Ensure workspace directory exists
    if (!fs.existsSync(workspaceDir())) {
      fs.mkdirSync(workspaceDir(), { recursive: true });
    }

    // Read all .md files
    const files = fs
      .readdirSync(workspaceDir())
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
 * Read full workspace context file content (MEMORY.md, daily logs, etc.)
 */
async function handleReadContextFile(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    const payload = message.payload as { fileName?: string } | undefined;
    const fileName = payload?.fileName?.trim();
    if (!fileName) {
      sendError(ws, message.id, "fileName is required");
      return;
    }

    if (fileName === "IDENTITY.md" || fileName.startsWith("IDENTITY")) {
      const { seedIdentityAboutFromProfile } =
        await import("../services/identityAboutSeed.js");
      await seedIdentityAboutFromProfile();
    }

    const filePath = resolveContextFilePath(fileName);
    if (!filePath || !fs.existsSync(filePath)) {
      sendError(ws, message.id, `File not found: ${fileName}`);
      return;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const stat = fs.statSync(filePath);
    sendResponse(ws, {
      id: message.id,
      success: true,
      data: {
        name: fileName,
        content,
        size: content.length,
        truncated: false,
        rawLength: content.length,
        path: filePath,
        updatedAt: stat.mtime.toISOString(),
      },
    });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

/**
 * Save workspace context file content (MEMORY.md, IDENTITY.md, daily logs, etc.)
 */
async function handleWriteContextFile(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    const payload = message.payload as
      { fileName?: string; content?: string } | undefined;
    const fileName = payload?.fileName?.trim();
    const content = payload?.content;

    if (!fileName) {
      sendError(ws, message.id, "fileName is required");
      return;
    }
    if (typeof content !== "string") {
      sendError(ws, message.id, "content must be a string");
      return;
    }
    if (Buffer.byteLength(content, "utf8") > MAX_CONTEXT_FILE_BYTES) {
      sendError(ws, message.id, "File exceeds maximum size (512 KB)");
      return;
    }

    const filePath = resolveContextFilePathForWrite(fileName);
    if (!filePath) {
      sendError(ws, message.id, `File not writable: ${fileName}`);
      return;
    }

    assertPathUnderWorkspace(filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");

    sendResponse(ws, {
      id: message.id,
      success: true,
      data: {
        name: fileName,
        content,
        size: content.length,
        truncated: false,
        rawLength: content.length,
        path: filePath,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

/**
 * Workspace + Papr memory context preview for Settings Memory tab
 */
async function handleGetContextPreview(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    const payload = message.payload as { forceRefresh?: boolean } | undefined;
    const forceRefresh = payload?.forceRefresh === true;

    const { getWorkspaceService } =
      await import("../services/WorkspaceService.js");
    const { getUserMemoryContextService } =
      await import("../services/UserMemoryContextService.js");
    const { readMemoryPreviewCache, writeMemoryPreviewCache } =
      await import("../services/MemoryPreviewCache.js");

    const workspaceService = getWorkspaceService();
    await workspaceService.initialize();
    const { seedIdentityAboutFromProfile } =
      await import("../services/identityAboutSeed.js");
    await seedIdentityAboutFromProfile();
    const ctx = await workspaceService.loadWorkspaceContext();

    const workspaceFiles = [
      ...ctx.files.map((file) => ({
        name: file.name,
        content: file.content,
        size: file.content.length,
        truncated: file.truncated,
        rawLength: file.rawLength,
        updatedAt: file.updatedAt,
      })),
      ...ctx.dailyLogs.map((log) => ({
        name: log.name,
        content: log.content,
        size: log.content.length,
        truncated: log.truncated,
        rawLength: log.rawLength,
        updatedAt: log.updatedAt,
      })),
    ];

    const memoryService = getUserMemoryContextService();
    const cached = await readMemoryPreviewCache();

    if (cached && !forceRefresh) {
      const needsTierRetry = cached.isIncomplete;
      if (!cached.isFresh || needsTierRetry) {
        memoryService.maybeRefreshMemoryPreviewCacheInBackground({
          isFresh: cached.isFresh,
          isIncomplete: cached.isIncomplete,
          syncTiersFailedAt: cached.syncTiersFailedAt,
        });
      }

      console.log(
        `[Memory] context-preview cache hit (${workspaceFiles.length} workspace files${needsTierRetry ? ", tier retry queued" : ""})`,
      );
      sendResponse(ws, {
        id: message.id,
        success: true,
        data: {
          workspaceFiles,
          onboardingPending: ctx.onboardingPending,
          paprMemory: cached.paprMemory,
          status: cached.status,
          cache: {
            fetchedAt: cached.fetchedAt,
            isStale: !cached.isFresh || needsTierRetry,
            fromCache: true,
            paprPending: needsTierRetry,
          },
        },
      });
      return;
    }

    if (!forceRefresh) {
      const quickStatus = await memoryService.buildQuickPreviewStatus();
      memoryService.maybeRefreshMemoryPreviewCacheInBackground();

      console.log(
        `[Memory] context-preview fast path (${workspaceFiles.length} workspace files, papr fetch in background)`,
      );
      sendResponse(ws, {
        id: message.id,
        success: true,
        data: {
          workspaceFiles,
          onboardingPending: ctx.onboardingPending,
          paprMemory: {
            goalsOkrs: null,
            useCases: null,
            syncTiers: null,
          },
          status: quickStatus,
          cache: {
            fetchedAt: new Date().toISOString(),
            isStale: false,
            fromCache: false,
            paprPending: true,
          },
        },
      });
      return;
    }

    console.log(
      "[Memory] context-preview force refresh (blocking remote fetch)",
    );
    const paprPreview = await memoryService.fetchMemoryPreviewForSettings({
      forceSyncTiers: true,
    });
    await writeMemoryPreviewCache({
      paprMemory: {
        goalsOkrs: paprPreview.goalsOkrs,
        useCases: paprPreview.useCases,
        syncTiers: paprPreview.syncTiers,
      },
      status: paprPreview.status,
      syncTiersFailedAt: paprPreview.status.errors.syncTiers
        ? new Date().toISOString()
        : null,
    });

    sendResponse(ws, {
      id: message.id,
      success: true,
      data: {
        workspaceFiles,
        onboardingPending: ctx.onboardingPending,
        paprMemory: {
          goalsOkrs: paprPreview.goalsOkrs,
          useCases: paprPreview.useCases,
          syncTiers: paprPreview.syncTiers,
        },
        status: paprPreview.status,
        cache: {
          fetchedAt: new Date().toISOString(),
          isStale: false,
          fromCache: false,
          paprPending: false,
        },
      },
    });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

interface UploadAttachmentPayload {
  filePath: string;
  chatId: string;
  fileName: string;
  mimeType?: string;
}

async function handleUploadAttachment(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    const payload = message.payload as UploadAttachmentPayload;
    if (!payload?.filePath || !payload?.chatId) {
      sendError(ws, message.id, "Missing filePath or chatId");
      return;
    }

    const { getPaprApiKey } = await import("../utils/keyResolver.js");
    const apiKey = await getPaprApiKey();
    if (!apiKey) {
      console.warn(
        "[Memory] Attachment upload skipped — no PAPR_API_KEY for active workspace",
        { filePath: payload.filePath, chatId: payload.chatId },
      );
      sendResponse(ws, {
        id: message.id,
        success: true,
        data: {
          skipped: true,
          reason: "No PAPR_API_KEY configured",
        },
      });
      return;
    }

    const { uploadAttachmentToMemory } =
      await import("../services/AttachmentMemoryUpload.js");

    console.log("[Memory] Uploading attachment to Papr Memory:", {
      filePath: payload.filePath,
      chatId: payload.chatId,
      fileName: payload.fileName,
    });

    const result = await uploadAttachmentToMemory(
      payload.filePath,
      payload.chatId,
      payload.fileName ?? path.basename(payload.filePath),
      payload.mimeType ?? "",
    );

    console.log("[Memory] Attachment upload complete:", {
      filePath: payload.filePath,
      uploadId: result?.uploadId ?? null,
      status: result?.status,
    });

    sendResponse(ws, {
      id: message.id,
      success: true,
      data: result ?? { skipped: true, reason: "Not a PDF or image" },
    });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

async function handleWikiHome(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    const payload = message.payload as { forceRefresh?: boolean } | undefined;
    const { fetchWikiHome } =
      await import("../services/KnowledgeGraphWikiService.js");
    const data = await fetchWikiHome({
      forceRefresh: payload?.forceRefresh === true,
    });
    sendResponse(ws, { id: message.id, success: true, data });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

async function handleWikiEntity(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    const payload = message.payload as
      { type?: string; id?: string; label?: string } | undefined;
    if (!payload?.type || !payload?.id) {
      sendError(ws, message.id, "Missing type or id");
      return;
    }

    const { fetchWikiEntity } =
      await import("../services/KnowledgeGraphWikiService.js");
    const data = await fetchWikiEntity(payload.type, payload.id, payload.label);
    sendResponse(ws, { id: message.id, success: true, data });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

async function handleWikiSearch(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    const payload = message.payload as { query?: string } | undefined;
    const { searchWiki } =
      await import("../services/KnowledgeGraphWikiService.js");
    const data = await searchWiki(payload?.query ?? "");
    sendResponse(ws, { id: message.id, success: true, data });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

async function handleWikiCreateEntity(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    const payload = message.payload as
      | {
          type?: string;
          name?: string;
          description?: string;
        }
      | undefined;
    if (!payload?.type || !payload?.name) {
      sendError(ws, message.id, "Missing type or name");
      return;
    }
    const { createWikiEntity } =
      await import("../services/KnowledgeGraphWikiService.js");
    const data = await createWikiEntity(
      payload.type,
      payload.name,
      payload.description ?? "",
    );
    sendResponse(ws, { id: message.id, success: true, data });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

async function handleWikiUpdateMedia(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    const payload = message.payload as
      | {
          type?: string;
          id?: string;
          kind?: "image" | "hero_image";
          dataUrl?: string | null;
        }
      | undefined;
    if (!payload?.type || !payload.id || !payload.kind) {
      sendError(ws, message.id, "Missing type, id, or media kind");
      return;
    }
    const { updateWikiEntityMedia } =
      await import("../services/KnowledgeGraphWikiService.js");
    const data = await updateWikiEntityMedia({
      type: payload.type,
      id: payload.id,
      kind: payload.kind,
      dataUrl: payload.dataUrl,
    });
    sendResponse(ws, { id: message.id, success: true, data });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

async function handleWikiToggleOpenItem(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    const payload = message.payload as
      | {
          type?: string;
          id?: string;
          itemIndex?: number;
          completed?: boolean;
        }
      | undefined;
    if (
      !payload?.type ||
      !payload.id ||
      typeof payload.itemIndex !== "number" ||
      typeof payload.completed !== "boolean"
    ) {
      sendError(
        ws,
        message.id,
        "Missing type, id, itemIndex, or completed flag",
      );
      return;
    }
    const { toggleEntityOpenItem } =
      await import("../services/wikiEntitySectionUpdate.js");
    const data = toggleEntityOpenItem({
      type: payload.type,
      id: payload.id,
      itemIndex: payload.itemIndex,
      completed: payload.completed,
    });
    sendResponse(ws, { id: message.id, success: true, data });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

async function handleWikiAddType(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    const payload = message.payload as
      | {
          typeName?: string;
          icon?: string;
          description?: string;
        }
      | undefined;
    if (!payload?.typeName) {
      sendError(ws, message.id, "Missing typeName");
      return;
    }
    const { addWikiType } =
      await import("../services/KnowledgeGraphWikiService.js");
    const data = await addWikiType(
      payload.typeName,
      payload.icon ?? "📌",
      payload.description ?? "",
    );
    sendResponse(ws, { id: message.id, success: true, data });
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}

/**
 * List Papr Memory schemas for the current namespace
 */
async function handleListSchemas(
  ws: WebSocket,
  message: WSMessage,
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
    const { PAPR_DEFAULT_HEADERS } = await import(
      "../../core/tools/paprSurface.js"
    );
    const client = new Papr({
      xAPIKey: apiKey,
      maxRetries: 2,
      timeout: 30_000,
      defaultHeaders: PAPR_DEFAULT_HEADERS,
    });

    const payload = message.payload as { statusFilter?: string } | undefined;
    const response = await client.schemas.list({
      status_filter: payload?.statusFilter as
        "draft" | "active" | "deprecated" | "archived" | undefined,
    });

    const responseData = response as {
      data?: Array<{
        id?: string;
        name?: string;
        description?: string;
        status?: string;
        version?: string;
        node_types?: Array<{ name?: string }> | Record<string, unknown>;
        relationship_types?: Array<{ name?: string }> | Record<string, unknown>;
      }>;
    };

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
      data: {
        schemas: [],
        error:
          error instanceof Error ? error.message : "Failed to list schemas",
      },
    });
  }
}
