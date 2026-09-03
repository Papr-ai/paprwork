import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { getPaprDocumentsDir } from "../utils/paprRoot.js";

const createDocumentSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe(
      "Human-readable document title (e.g. 'Knowledge Graphs Overview', not an ID)",
    ),
  content: z
    .string()
    .optional()
    .describe("Initial markdown content for the document"),
});

const importDocumentSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .describe(
      "Absolute or ~-prefixed path to a file on the user's device (e.g. ~/Documents/notes.md)",
    ),
  title: z
    .string()
    .optional()
    .describe(
      "Optional custom title. Defaults to the filename without extension.",
    ),
});

// Accept `id` as an alias for `documentId` — LLMs frequently call read_document
// with `id` instead of `documentId`. Silently normalize to avoid validation retry.
const readDocumentSchema = z.preprocess(
  (val) => {
    if (val && typeof val === "object" && val !== null) {
      const obj = val as Record<string, unknown>;
      if (typeof obj.id === "string" && !obj.documentId) {
        return { ...obj, documentId: obj.id };
      }
    }
    return val;
  },
  z.object({
    documentId: z
      .string()
      .min(1)
      .describe("Document UUID (also accepted as 'id')"),
  }),
);

const listDocumentsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Optional search query to filter documents"),
});

export const createDocumentTool = createTool({
  id: "create_document",
  description:
    "Create a new markdown document in Paprwork. Use a clear, descriptive title (e.g. 'Knowledge Graphs Overview'). " +
    "The document opens automatically in the editor. Returns filePath for bash edits.",
  inputSchema: createDocumentSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof createDocumentSchema> }).context ??
      input;
    const { getDocumentService } =
      await import("../../gateway/services/DocumentService.js");
    const service = getDocumentService();
    const document = await service.createDocument(
      args.title,
      args.content ?? "",
    );
    return {
      success: true,
      data: {
        id: document.id,
        title: document.title,
        filePath: document.filePath,
        createdAt: document.createdAt,
        preview: document.preview,
      },
      hint: `Document created at ${document.filePath}. Use bash to edit the markdown file directly.`,
    };
  },
});

export const readDocumentTool = createTool({
  id: "read_document",
  description:
    "Read a document by id. Returns content and filePath for bash editing.",
  inputSchema: readDocumentSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof readDocumentSchema> }).context ??
      input;
    const { getDocumentService } =
      await import("../../gateway/services/DocumentService.js");
    const service = getDocumentService();
    const document = await service.getDocument(args.documentId);
    if (!document) {
      throw new Error(`Document not found: ${args.documentId}`);
    }
    return {
      success: true,
      data: {
        id: document.id,
        title: document.title,
        content: document.content,
        filePath: document.filePath,
        tags: document.tags,
        favorite: document.favorite,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        wordCount: document.wordCount,
      },
    };
  },
});

export const listDocumentsTool = createTool({
  id: "list_documents",
  description: "List documents, optionally filtered by search query",
  inputSchema: listDocumentsSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof listDocumentsSchema> }).context ??
      input;
    const { getDocumentService } =
      await import("../../gateway/services/DocumentService.js");
    const service = getDocumentService();
    const documents = args.query
      ? await service.searchDocuments(args.query)
      : await service.listDocuments();
    return {
      success: true,
      data: documents,
    };
  },
});

export const importDocumentTool = createTool({
  id: "import_document",
  description:
    "Import a file from the user's device into Papr as a document. " +
    "Supports Markdown, text, and Word (.docx) files. " +
    "DOCX files are automatically converted to Markdown. " +
    "Use this when a user says 'open', 'import', or 'edit' a file from their filesystem.",
  inputSchema: importDocumentSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof importDocumentSchema> }).context ??
      input;

    // Resolve ~ to home directory
    let resolvedPath = args.filePath;
    if (resolvedPath.startsWith("~")) {
      resolvedPath = path.join(os.homedir(), resolvedPath.slice(1));
    }
    resolvedPath = path.resolve(resolvedPath);

    // Read and convert the source file based on extension
    const ext = path.extname(resolvedPath).toLowerCase();
    let content: string;
    try {
      if (ext === ".docx") {
        // Convert DOCX → HTML → Markdown
        const mammoth = await import("mammoth");
        const TurndownService = (await import("turndown")).default;
        const buffer = await fs.readFile(resolvedPath);
        const result = await mammoth.convertToHtml({ buffer });
        const td = new TurndownService({ headingStyle: "atx" });
        content = td.turndown(result.value);
      } else {
        content = await fs.readFile(resolvedPath, "utf-8");
      }
    } catch (error) {
      throw new Error(
        `Cannot read file at ${resolvedPath}: ${(error as Error).message}`,
      );
    }

    // Determine title
    const title =
      args.title ?? path.basename(resolvedPath, path.extname(resolvedPath));

    // Create the Papr document
    const { getDocumentService } =
      await import("../../gateway/services/DocumentService.js");
    const service = getDocumentService();
    const document = await service.createDocument(title, content);

    // Save the original path in meta so we can write back later
    const metaPath = path.join(
      getPaprDocumentsDir(),
      document.id,
      "meta.json",
    );
    try {
      const raw = await fs.readFile(metaPath, "utf-8");
      const meta = JSON.parse(raw) as Record<string, unknown>;
      meta.originalPath = resolvedPath;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    } catch {
      // Non-critical — meta update failed
    }

    // Save initial version
    try {
      await service.saveVersion(document.id, content, "Imported from device");
    } catch {
      // Non-critical
    }

    return {
      success: true,
      data: {
        id: document.id,
        title: document.title,
        filePath: document.filePath,
        originalPath: resolvedPath,
        createdAt: document.createdAt,
        wordCount: document.wordCount,
      },
      hint: `Imported "${path.basename(resolvedPath)}" as a Papr document. The original file is at ${resolvedPath}. Use bash to edit the markdown at ${document.filePath}.`,
    };
  },
});

export const documentTools = [
  createDocumentTool,
  readDocumentTool,
  listDocumentsTool,
  importDocumentTool,
];
