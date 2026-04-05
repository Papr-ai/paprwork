/**
 * DocumentService - File-based document management
 *
 * Storage layout:
 *   ~/Papr/documents/{docId}/content.md   -- markdown content
 *   ~/Papr/documents/{docId}/meta.json    -- title, tags, favorite, timestamps
 *   ~/Papr/documents/{docId}/versions/    -- version snapshots
 *
 * Migrates legacy documents.json on first init.
 */

import { promises as fs } from "fs";
import { watch, type FSWatcher } from "fs";
import path from "path";
import os from "os";
// uuid no longer needed — document IDs are title-based slugs

// ---------- Public Types ----------

export interface DocumentMeta {
  id: string;
  title: string;
  type: "document";
  createdAt: string;
  updatedAt: string;
  tags: string[];
  favorite: boolean;
  preview: string;
  wordCount: number;
  createdByAgentId?: string;
  createdByAgentName?: string;
}

/** Full document (meta + content). Returned by getDocument(). */
export interface Document extends DocumentMeta {
  content: string;
  /** Absolute path to the content.md file so the agent can bash-edit it. */
  filePath: string;
}

export interface DocumentVersion {
  versionId: string;
  timestamp: string;
  reason: string;
  preview: string;
}

export interface DocumentVersionFull extends DocumentVersion {
  content: string;
}

type FileChangeCallback = (docId: string) => void;

// ---------- Service ----------

let documentServiceInstance: DocumentService | null = null;

export class DocumentService {
  private docsRoot: string;
  private legacyJsonPath: string;
  private initialized = false;
  private watchers: Map<string, FSWatcher> = new Map();
  private fileChangeCallbacks: Set<FileChangeCallback> = new Set();

  constructor() {
    const homeDir = os.homedir();
    this.docsRoot = path.join(homeDir, "Papr", "documents");
    this.legacyJsonPath = path.join(
      homeDir,
      ".paprwork",
      "data",
      "documents.json",
    );
  }

  // ===== Lifecycle =====

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(this.docsRoot, { recursive: true });
    await this.migrateLegacyIfNeeded();
    this.initialized = true;

    const docIds = await this.listDocIds();
    console.log(
      `[DocumentService] Initialized with ${docIds.length} documents in ${this.docsRoot}`,
    );
  }

  close(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  // ===== File-change watching =====

  onFileChange(callback: FileChangeCallback): () => void {
    this.fileChangeCallbacks.add(callback);
    return () => this.fileChangeCallbacks.delete(callback);
  }

  /** Start watching a document's content.md for external changes. */
  watchDocument(docId: string): void {
    if (this.watchers.has(docId)) return;

    const contentPath = this.contentPath(docId);
    try {
      const watcher = watch(contentPath, { persistent: false }, () => {
        for (const cb of this.fileChangeCallbacks) {
          cb(docId);
        }
      });
      this.watchers.set(docId, watcher);
    } catch {
      // File may not exist yet; that's fine.
    }
  }

  unwatchDocument(docId: string): void {
    const watcher = this.watchers.get(docId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(docId);
    }
  }

  // ===== CRUD =====

  async createDocument(
    title: string,
    content: string = "",
    createdByAgentId?: string,
    createdByAgentName?: string,
  ): Promise<Document> {
    const id = await this.generateUniqueSlug(title);
    const now = new Date().toISOString();

    const meta: DocumentMeta = {
      id,
      title,
      type: "document",
      createdAt: now,
      updatedAt: now,
      tags: [],
      favorite: false,
      preview: content.slice(0, 200),
      wordCount: wordCount(content),
      createdByAgentId,
      createdByAgentName,
    };

    const docDir = this.docDir(id);
    const versionsDir = path.join(docDir, "versions");
    await fs.mkdir(versionsDir, { recursive: true });
    await fs.writeFile(this.contentPath(id), content, "utf-8");
    await this.writeMeta(id, meta);

    console.log(`[DocumentService] Created document: ${id} - ${title}`);
    return { ...meta, content, filePath: this.contentPath(id) };
  }

  /**
   * Generate a unique slug from a title. Appends -2, -3, etc. on collision.
   */
  private async generateUniqueSlug(title: string): Promise<string> {
    const base = slugify(title);
    let candidate = base;
    let counter = 1;

    while (true) {
      const docDir = this.docDir(candidate);
      try {
        await fs.access(docDir);
        // Directory exists — collision, try next suffix
        counter++;
        candidate = `${base}-${counter}`;
      } catch {
        // Directory does not exist — slug is available
        return candidate;
      }
    }
  }

  async getDocument(id: string): Promise<Document | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;

    let content = "";
    try {
      content = await fs.readFile(this.contentPath(id), "utf-8");
    } catch {
      /* content.md may not exist yet */
    }

    return { ...meta, content, filePath: this.contentPath(id) };
  }

  async updateDocument(
    id: string,
    updates: Partial<
      Omit<DocumentMeta, "id" | "type" | "createdAt"> & { content: string }
    >,
  ): Promise<Document | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;

    let content: string | undefined;

    // Write content if provided
    if (updates.content !== undefined) {
      content = updates.content;
      await fs.writeFile(this.contentPath(id), content, "utf-8");
    }

    // Read current content if we didn't get it from updates
    if (content === undefined) {
      try {
        content = await fs.readFile(this.contentPath(id), "utf-8");
      } catch {
        content = "";
      }
    }

    const updatedMeta: DocumentMeta = {
      ...meta,
      title: updates.title ?? meta.title,
      tags: updates.tags ?? meta.tags,
      favorite: updates.favorite ?? meta.favorite,
      updatedAt: new Date().toISOString(),
      preview: content.slice(0, 200),
      wordCount: wordCount(content),
    };

    await this.writeMeta(id, updatedMeta);
    console.log(`[DocumentService] Updated document: ${id}`);
    return { ...updatedMeta, content, filePath: this.contentPath(id) };
  }

  async deleteDocument(id: string): Promise<boolean> {
    const docDir = this.docDir(id);
    try {
      await fs.rm(docDir, { recursive: true, force: true });
      this.unwatchDocument(id);
      console.log(`[DocumentService] Deleted document: ${id}`);
      return true;
    } catch {
      return false;
    }
  }

  async listDocuments(): Promise<DocumentMeta[]> {
    const ids = await this.listDocIds();
    const metas: DocumentMeta[] = [];

    for (const id of ids) {
      const meta = await this.readMeta(id);
      if (meta) metas.push(meta);
    }

    return metas.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async searchDocuments(query: string): Promise<DocumentMeta[]> {
    const all = await this.listDocuments();
    const lower = query.toLowerCase();
    return all.filter(
      (doc) =>
        doc.title.toLowerCase().includes(lower) ||
        doc.preview.toLowerCase().includes(lower) ||
        doc.tags.some((tag) => tag.toLowerCase().includes(lower)),
    );
  }

  async toggleFavorite(id: string): Promise<Document | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;

    meta.favorite = !meta.favorite;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(id, meta);

    let content = "";
    try {
      content = await fs.readFile(this.contentPath(id), "utf-8");
    } catch {
      /* noop */
    }

    return { ...meta, content, filePath: this.contentPath(id) };
  }

  // ===== Version History =====

  async saveVersion(
    docId: string,
    content: string,
    reason: string = "save",
  ): Promise<string> {
    const versionsDir = path.join(this.docDir(docId), "versions");
    await fs.mkdir(versionsDir, { recursive: true });

    const timestamp = new Date().toISOString();
    const safeTimestamp = timestamp.replace(/[:.]/g, "-");
    const versionId = `${safeTimestamp}_${reason}`;
    const versionPath = path.join(versionsDir, `${versionId}.md`);

    // Deduplicate: check latest version's content
    const existing = await this.getVersionHistory(docId);
    if (existing.length > 0) {
      const latest = await this.getVersion(docId, existing[0].versionId);
      if (latest && latest.content === content) {
        return existing[0].versionId; // No change, skip
      }
    }

    await fs.writeFile(versionPath, content, "utf-8");
    return versionId;
  }

  async getVersionHistory(docId: string): Promise<DocumentVersion[]> {
    const versionsDir = path.join(this.docDir(docId), "versions");

    let files: string[];
    try {
      files = await fs.readdir(versionsDir);
    } catch {
      return [];
    }

    const versions: DocumentVersion[] = files
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const name = f.replace(".md", "");
        const parts = name.split("_");
        const reason = parts.slice(6).join("_") || "save"; // timestamp has 6 parts
        return {
          versionId: name,
          timestamp: versionIdToTimestamp(name),
          reason,
          preview: "", // Filled below lazily
        };
      })
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );

    // Load preview for first 20 versions
    for (const v of versions.slice(0, 20)) {
      try {
        const content = await fs.readFile(
          path.join(versionsDir, `${v.versionId}.md`),
          "utf-8",
        );
        v.preview = content.slice(0, 200);
      } catch {
        /* noop */
      }
    }

    return versions;
  }

  async getVersion(
    docId: string,
    versionId: string,
  ): Promise<DocumentVersionFull | null> {
    const versionPath = path.join(
      this.docDir(docId),
      "versions",
      `${versionId}.md`,
    );

    try {
      const content = await fs.readFile(versionPath, "utf-8");
      return {
        versionId,
        timestamp: versionIdToTimestamp(versionId),
        reason: versionId.split("_").slice(6).join("_") || "save",
        preview: content.slice(0, 200),
        content,
      };
    } catch {
      return null;
    }
  }

  async restoreVersion(
    docId: string,
    versionId: string,
  ): Promise<Document | null> {
    const version = await this.getVersion(docId, versionId);
    if (!version) return null;

    // Save current content as a version before restoring
    let currentContent = "";
    try {
      currentContent = await fs.readFile(this.contentPath(docId), "utf-8");
    } catch {
      /* noop */
    }
    if (currentContent) {
      await this.saveVersion(docId, currentContent, "before-restore");
    }

    return this.updateDocument(docId, { content: version.content });
  }

  // ===== DOCX Export =====

  async exportToDocx(docId: string): Promise<Buffer> {
    const doc = await this.getDocument(docId);
    if (!doc) throw new Error(`Document not found: ${docId}`);

    const {
      Document: DocxDocument,
      Packer,
      Paragraph,
      TextRun,
      HeadingLevel,
      AlignmentType,
    } = await import("docx");

    const paragraphs = markdownToDocxParagraphs(doc.content, {
      Paragraph,
      TextRun,
      HeadingLevel,
      AlignmentType,
    });

    const docxDoc = new DocxDocument({
      sections: [{ properties: {}, children: paragraphs }],
    });

    const buffer = await Packer.toBuffer(docxDoc);
    return Buffer.from(buffer);
  }

  // ===== Helpers for document tools =====

  getDocumentFilePath(docId: string): string {
    return this.contentPath(docId);
  }

  // ===== Internal helpers =====

  private docDir(id: string): string {
    return path.join(this.docsRoot, id);
  }

  private contentPath(id: string): string {
    return path.join(this.docsRoot, id, "content.md");
  }

  private metaPath(id: string): string {
    return path.join(this.docsRoot, id, "meta.json");
  }

  private async readMeta(id: string): Promise<DocumentMeta | null> {
    try {
      const raw = await fs.readFile(this.metaPath(id), "utf-8");
      return JSON.parse(raw) as DocumentMeta;
    } catch {
      return null;
    }
  }

  private async writeMeta(id: string, meta: DocumentMeta): Promise<void> {
    await fs.writeFile(
      this.metaPath(id),
      JSON.stringify(meta, null, 2),
      "utf-8",
    );
  }

  private async listDocIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.docsRoot, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  // ===== Legacy migration =====

  private async migrateLegacyIfNeeded(): Promise<void> {
    try {
      const raw = await fs.readFile(this.legacyJsonPath, "utf-8");
      const legacyDocs = JSON.parse(raw) as Array<{
        id: string;
        title: string;
        content: string;
        createdAt: string;
        updatedAt: string;
        tags?: string[];
        favorite?: boolean;
      }>;

      if (legacyDocs.length === 0) return;

      let migrated = 0;
      for (const doc of legacyDocs) {
        // Skip if already migrated
        const existing = await this.readMeta(doc.id);
        if (existing) continue;

        const docDir = this.docDir(doc.id);
        const versionsDir = path.join(docDir, "versions");
        await fs.mkdir(versionsDir, { recursive: true });

        const content = doc.content || "";
        await fs.writeFile(this.contentPath(doc.id), content, "utf-8");

        const meta: DocumentMeta = {
          id: doc.id,
          title: doc.title,
          type: "document",
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
          tags: doc.tags ?? [],
          favorite: doc.favorite ?? false,
          preview: content.slice(0, 200),
          wordCount: wordCount(content),
        };
        await this.writeMeta(doc.id, meta);
        migrated++;
      }

      if (migrated > 0) {
        console.log(
          `[DocumentService] Migrated ${migrated} documents from legacy JSON`,
        );
        // Rename legacy file so we don't migrate again
        await fs.rename(this.legacyJsonPath, this.legacyJsonPath + ".migrated");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[DocumentService] Legacy migration error:", error);
      }
      // No legacy file, nothing to migrate
    }
  }
}

// ===== DOCX Conversion =====

interface DocxHelpers {
  Paragraph: typeof import("docx").Paragraph;
  TextRun: typeof import("docx").TextRun;
  HeadingLevel: typeof import("docx").HeadingLevel;
  AlignmentType: typeof import("docx").AlignmentType;
}

/**
 * Convert markdown text to an array of docx Paragraph objects.
 * Handles headings, bold, italic, underline, strike, lists, blockquotes, code blocks.
 */
function markdownToDocxParagraphs(
  markdown: string,
  { Paragraph, TextRun, HeadingLevel }: DocxHelpers,
): InstanceType<typeof import("docx").Paragraph>[] {
  const lines = markdown.split("\n");
  const paragraphs: InstanceType<typeof import("docx").Paragraph>[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];

  const headingLevelMap: Record<
    number,
    (typeof HeadingLevel)[keyof typeof HeadingLevel]
  > = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6,
  };

  const parseInlineRuns = (
    text: string,
  ): InstanceType<typeof import("docx").TextRun>[] => {
    const runs: InstanceType<typeof import("docx").TextRun>[] = [];
    // Simple regex-based inline parsing
    const regex =
      /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`(.+?)`|__(.+?)__|_(.+?)_)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      // Text before match
      if (match.index > lastIndex) {
        runs.push(new TextRun({ text: text.slice(lastIndex, match.index) }));
      }

      if (match[2]) {
        // ***bold italic***
        runs.push(new TextRun({ text: match[2], bold: true, italics: true }));
      } else if (match[3]) {
        // **bold**
        runs.push(new TextRun({ text: match[3], bold: true }));
      } else if (match[4]) {
        // *italic*
        runs.push(new TextRun({ text: match[4], italics: true }));
      } else if (match[5]) {
        // ~~strike~~
        runs.push(new TextRun({ text: match[5], strike: true }));
      } else if (match[6]) {
        // `code`
        runs.push(
          new TextRun({ text: match[6], font: { name: "Courier New" } }),
        );
      } else if (match[7]) {
        // __underline__
        runs.push(new TextRun({ text: match[7], underline: {} }));
      } else if (match[8]) {
        // _italic_
        runs.push(new TextRun({ text: match[8], italics: true }));
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      runs.push(new TextRun({ text: text.slice(lastIndex) }));
    }

    if (runs.length === 0) {
      runs.push(new TextRun({ text }));
    }

    return runs;
  };

  for (const line of lines) {
    // Code block fence
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        // End of code block
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: codeLines.join("\n"),
                font: { name: "Courier New" },
                size: 20,
              }),
            ],
          }),
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      paragraphs.push(
        new Paragraph({
          heading: headingLevelMap[level] ?? HeadingLevel.HEADING_1,
          children: parseInlineRuns(text),
        }),
      );
      continue;
    }

    // Unordered list
    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.+)/);
    if (bulletMatch) {
      const text = bulletMatch[2];
      paragraphs.push(
        new Paragraph({
          bullet: { level: 0 },
          children: parseInlineRuns(text),
        }),
      );
      continue;
    }

    // Ordered list
    const orderedMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (orderedMatch) {
      const text = orderedMatch[2];
      paragraphs.push(
        new Paragraph({
          numbering: { reference: "default-numbering", level: 0 },
          children: parseInlineRuns(text),
        }),
      );
      continue;
    }

    // Blockquote
    const quoteMatch = line.match(/^>\s*(.*)/);
    if (quoteMatch) {
      const text = quoteMatch[1];
      paragraphs.push(
        new Paragraph({
          indent: { left: 720 },
          children: [new TextRun({ text, italics: true, color: "666666" })],
        }),
      );
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      paragraphs.push(new Paragraph({ children: [] }));
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      paragraphs.push(new Paragraph({ children: [] }));
      continue;
    }

    // Normal paragraph
    paragraphs.push(new Paragraph({ children: parseInlineRuns(line) }));
  }

  // Flush remaining code block
  if (inCodeBlock && codeLines.length > 0) {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: codeLines.join("\n"),
            font: { name: "Courier New" },
            size: 20,
          }),
        ],
      }),
    );
  }

  return paragraphs;
}

// ===== Utility functions =====

/** Convert a title to a URL-safe slug for use as a folder name. */
function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "") // Remove non-word chars (except spaces and hyphens)
      .replace(/\s+/g, "-") // Spaces to hyphens
      .replace(/-+/g, "-") // Collapse multiple hyphens
      .replace(/^-|-$/g, "") // Trim leading/trailing hyphens
      .slice(0, 80) || // Cap length
    "untitled"
  ); // Fallback
}

function wordCount(text: string): number {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

function versionIdToTimestamp(versionId: string): string {
  // Format: YYYY-MM-DDTHH-MM-SS-sssZ_reason
  // Convert dashes back to colons/dots for valid ISO
  const parts = versionId.split("_");
  // Reconstruct: parts[0]=YYYY, parts[1]=MM, parts[2]=DDTHHh, etc.
  // Simpler: just use the file's mtime as fallback, or parse what we can
  try {
    const datePart = parts.slice(0, 6).join("-");
    // YYYY-MM-DDTHH-MM-SS-sssZ -> YYYY-MM-DDTHH:MM:SS.sssZ
    const iso = datePart
      .replace(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/,
        "$1-$2-$3T$4:$5:$6",
      )
      .replace(/-(\d{3})Z/, ".$1Z");
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch {
    /* fallback */
  }
  return new Date().toISOString();
}

// ===== Singleton =====

export function getDocumentService(): DocumentService {
  if (!documentServiceInstance) {
    documentServiceInstance = new DocumentService();
  }
  return documentServiceInstance;
}

export async function initializeDocumentService(): Promise<DocumentService> {
  const service = getDocumentService();
  await service.initialize();
  return service;
}
