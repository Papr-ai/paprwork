import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPaprClient, handlePaprToolError } from "./paprClient.js";
import { resolveConversationId } from "./chatScope.js";
import { getCurrentChatId } from "./context.js";

const execFileAsync = promisify(execFile);

const uploadDocumentSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .describe("Absolute path to PDF or image file on disk"),
  chatId: z
    .string()
    .optional()
    .describe("Optional chat ID to tag the upload for later filtering"),
  fileName: z
    .string()
    .optional()
    .describe("Optional display name (defaults to basename of filePath)"),
});

const documentUploadStatusSchema = z.object({
  uploadId: z
    .string()
    .min(1)
    .describe("upload_id from upload_document_to_memory response"),
});

const parsePdfSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .describe("Absolute path to a local PDF file"),
  maxChars: z
    .number()
    .int()
    .min(1000)
    .max(200000)
    .optional()
    .describe("Max characters to return (default 50000). Use when summarizing large PDFs."),
});

function expandHome(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", filePath.slice(2));
  }
  return filePath;
}

interface MemoryContentHit {
  memoryId: string;
  content: string;
}

function extractMemoriesFromSearchResponse(
  response: unknown,
): MemoryContentHit[] {
  const root = response as Record<string, unknown>;
  const inner = (root.data ?? root) as Record<string, unknown>;
  const memories = inner.memories;
  if (!Array.isArray(memories)) {
    return [];
  }

  const hits: MemoryContentHit[] = [];
  for (const entry of memories) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const memory = entry as Record<string, unknown>;
    const content =
      typeof memory.content === "string" ? memory.content.trim() : "";
    const memoryId =
      typeof memory.id === "string"
        ? memory.id
        : typeof memory.memoryId === "string"
          ? memory.memoryId
          : undefined;
    if (memoryId && content.length >= 200) {
      hits.push({ memoryId, content });
    }
  }
  return hits;
}

interface PdfFromMemoryResult {
  text: string;
  memoryIds: string[];
  matchedBy: "file_name_filter" | "semantic_search";
}

/** Return extracted PDF text from Papr Memory when this file was already indexed. */
export async function tryLoadPdfFromMemory(
  resolvedPath: string,
  maxChars: number,
): Promise<PdfFromMemoryResult | null> {
  try {
    const { getApiKey } = await import("../../gateway/utils/keyResolver.js");
    const apiKey = await getApiKey("PAPR_API_KEY");
    if (!apiKey) {
      return null;
    }
  } catch {
    return null;
  }

  const fileName = path.basename(resolvedPath);
  const stem = path.basename(resolvedPath, path.extname(resolvedPath));

  try {
    const client = await getPaprClient();
    const { paprMemorySearchScopeSpread } = await import(
      "../../gateway/utils/memoryScopeResolver.js"
    );

    const attempts: Array<{
      query: string;
      matchedBy: PdfFromMemoryResult["matchedBy"];
      customMetadata?: Record<string, string>;
    }> = [
      {
        query: `${fileName} PDF document extracted text`,
        matchedBy: "file_name_filter",
        customMetadata: { file_name: fileName },
      },
      {
        query: `${stem} PDF report document content`,
        matchedBy: "semantic_search",
      },
    ];

    const searchScope = await paprMemorySearchScopeSpread();

    for (const attempt of attempts) {
      const response = await client.memory.search({
        query: attempt.query,
        ...searchScope,
        max_memories: 8,
        ...(attempt.customMetadata
          ? { metadata: { customMetadata: attempt.customMetadata } }
          : {}),
      });

      const hits = extractMemoriesFromSearchResponse(response);
      if (hits.length === 0) {
        continue;
      }

      const combined = hits.map((hit) => hit.content).join("\n\n");
      const truncated = combined.length > maxChars;
      const text = truncated
        ? `${combined.slice(0, maxChars)}\n\n[... truncated at ${maxChars} chars — use search_agent_memory({ memoryId }) for full content]`
        : combined;

      return {
        text,
        memoryIds: hits.map((hit) => hit.memoryId),
        matchedBy: attempt.matchedBy,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export const uploadDocumentToMemoryTool = createTool({
  id: "upload_document_to_memory",
  description:
    "Upload a PDF or image to Papr Memory for OCR, chunking, and semantic indexing. " +
    "Returns upload_id and memory_item IDs immediately; processing continues async. " +
    "Poll get_document_upload_status until completed, then search_agent_memory({ memoryId }) on returned memory IDs to read extracted text. " +
    "Prefer this over read_file base64 for PDFs and images when PAPR_API_KEY is configured.",
  inputSchema: uploadDocumentSchema,
  execute: async (args) => {
    try {
      const resolvedPath = expandHome(args.filePath);
      const fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) {
        throw new Error(`Not a file: ${resolvedPath}`);
      }

      const fileName = args.fileName ?? path.basename(resolvedPath);
      const client = await getPaprClient();
      const { buildAgentMemoryAddPolicy } = await import(
        "../../gateway/utils/workspaceContextSchema.js"
      );
      const { paprMemoryScopeSpread, paprMemoryDocumentUploadFields } =
        await import("../../gateway/utils/memoryScopeResolver.js");
      const resolvedChatId = resolveConversationId(
        args.chatId ?? getCurrentChatId() ?? undefined,
      );
      const addPolicy = await buildAgentMemoryAddPolicy({ client });
      const memoryScope = await paprMemoryScopeSpread({
        chatId: resolvedChatId,
        addPolicy,
      });

      const metadataPayload: Record<string, unknown> = {
        customMetadata: {
          file_name: fileName,
          source: "paprwork_attachment",
          ...(resolvedChatId ? { chat_id: resolvedChatId } : {}),
        },
      };

      const response = await client.document.upload({
        file: createReadStream(resolvedPath),
        ...paprMemoryDocumentUploadFields(memoryScope),
        metadata: JSON.stringify(metadataPayload),
      });

      const memoryItems = response.memory_items ?? response.memories ?? [];
      const uploadId =
        response.document_status?.upload_id ??
        (typeof response.document_status === "object" &&
        response.document_status !== null &&
        "upload_id" in response.document_status
          ? String(response.document_status.upload_id)
          : undefined);

      return {
        success: true,
        data: {
          uploadId,
          status: response.status ?? response.document_status?.status_type ?? "processing",
          progress: response.document_status?.progress ?? 0,
          pageId: response.document_status?.page_id ?? null,
          memoryItems: memoryItems.map((item) => ({
            memoryId: item.memoryId,
            objectId: item.objectId,
            createdAt: item.createdAt,
          })),
          filePath: resolvedPath,
          fileName,
          hint:
            "Poll get_document_upload_status({ uploadId }) until completed, then search_agent_memory({ memoryId }) for full extracted text.",
        },
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const getDocumentUploadStatusTool = createTool({
  id: "get_document_upload_status",
  description:
    "Poll Papr Memory document processing status for an upload_id. " +
    "Returns progress (0–1), status_type (processing/completed/failed), page_id, and memory_items when available. " +
    "Call repeatedly until status_type is completed or failed.",
  inputSchema: documentUploadStatusSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const response = await client.document.getStatus(args.uploadId);
      const status = response as Record<string, unknown>;

      const documentStatus =
        (status.document_status as Record<string, unknown> | undefined) ?? status;

      return {
        success: true,
        data: {
          uploadId: args.uploadId,
          statusType: documentStatus.status_type ?? status.status ?? "unknown",
          progress: documentStatus.progress ?? status.progress ?? null,
          pageId: documentStatus.page_id ?? status.page_id ?? null,
          totalPages: documentStatus.total_pages ?? status.total_pages ?? null,
          error: documentStatus.error ?? status.error ?? null,
          memoryItems: (status.memory_items as Array<{ memoryId?: string }> | undefined)?.map(
            (item) => item.memoryId,
          ),
          raw: response,
          hint:
            "When statusType is completed, use search_agent_memory({ memoryId }) to read extracted content, or search with customMetadataFilters: { upload_id: uploadId }.",
        },
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const parsePdfTool = createTool({
  id: "parse_pdf",
  description:
    "Extract text from a local PDF using Python pypdf. " +
    "**Checks Papr Memory first** — if this file was already uploaded or parsed, returns cached extracted text (no re-parse). " +
    "Only parses locally when memory has no match. " +
    "Prefer search_agent_memory({ memoryId }) or upload_document_to_memory when Papr is configured. " +
    "Install pypdf first if missing: pip install pypdf (or ask user permission).",
  inputSchema: parsePdfSchema,
  execute: async (args) => {
    const resolvedPath = expandHome(args.filePath);
    const maxChars = args.maxChars ?? 50000;

    const fromMemory = await tryLoadPdfFromMemory(resolvedPath, maxChars);
    if (fromMemory) {
      return {
        success: true,
        data: {
          source: "papr_memory",
          matchedBy: fromMemory.matchedBy,
          memoryIds: fromMemory.memoryIds,
          filePath: resolvedPath,
          fileName: path.basename(resolvedPath),
          charCount: fromMemory.text.length,
          truncated: fromMemory.text.includes("[... truncated at"),
          text: fromMemory.text,
          hint:
            "Loaded from Papr Memory — do NOT call parse_pdf again for this file. " +
            "Use search_agent_memory({ memoryId }) to refresh or fetch more chunks.",
        },
      };
    }

    const script = `
import json, sys
from pathlib import Path
try:
    from pypdf import PdfReader
except ImportError:
    from PyPDF2 import PdfReader
path = Path(sys.argv[1])
max_chars = int(sys.argv[2])
reader = PdfReader(str(path))
parts = []
total = 0
for i, page in enumerate(reader.pages):
    text = page.extract_text() or ""
    if not text.strip():
        continue
    parts.append(f"--- Page {i + 1} ---\\n{text}")
    total += len(text)
text = "\\n\\n".join(parts)
truncated = len(text) > max_chars
if truncated:
    text = text[:max_chars] + f"\\n\\n[... truncated at {max_chars} chars, {len(parts)} pages parsed]"
print(json.dumps({
    "success": True,
    "pageCount": len(reader.pages),
    "pagesWithText": len(parts),
    "charCount": min(len(text), max_chars),
    "truncated": truncated,
    "text": text,
}))
`.trim();

    try {
      const { stdout } = await execFileAsync("python3", ["-c", script, resolvedPath, String(maxChars)], {
        maxBuffer: maxChars + 4096,
        timeout: 60000,
      });
      const parsed = JSON.parse(stdout) as {
        success: boolean;
        pageCount: number;
        pagesWithText: number;
        charCount: number;
        truncated: boolean;
        text: string;
      };
      return { success: true, data: { ...parsed, source: "pypdf_local" } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("No module named")) {
        throw new Error(
          "pypdf is not installed. Run: pip install pypdf — or wait for Papr Memory upload to finish and use search_agent_memory({ memoryId }) instead.",
        );
      }
      throw new Error(`Failed to parse PDF: ${message}`);
    }
  },
});

export const paprDocumentMemoryTools = [
  uploadDocumentToMemoryTool,
  getDocumentUploadStatusTool,
  parsePdfTool,
];
