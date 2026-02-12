/**
 * DocumentService - Document management
 * Reference: Paprwork v1 documentManager.js
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";

export interface Document {
  id: string;
  title: string;
  content: string;
  type: "document";
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  favorite?: boolean;
  preview?: string;
}

let documentServiceInstance: DocumentService | null = null;

export class DocumentService {
  private documentsPath: string;
  private documents: Map<string, Document>;
  private initialized: boolean;

  constructor() {
    const homeDir = os.homedir();
    const userDataPath = path.join(homeDir, ".paprwork", "data");
    this.documentsPath = path.join(userDataPath, "documents.json");
    this.documents = new Map();
    this.initialized = false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const dataDir = path.dirname(this.documentsPath);
    await fs.mkdir(dataDir, { recursive: true });
    await this.loadDocuments();
    this.initialized = true;
    console.log(
      `[DocumentService] Initialized with ${this.documents.size} documents`,
    );
  }

  private async loadDocuments(): Promise<void> {
    try {
      const data = await fs.readFile(this.documentsPath, "utf-8");
      const documentsArray: Document[] = JSON.parse(data);
      this.documents = new Map(documentsArray.map((doc) => [doc.id, doc]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[DocumentService] Failed to load documents:", error);
      }
      // File doesn't exist yet, start with empty map
      this.documents = new Map();
    }
  }

  private async saveDocuments(): Promise<void> {
    const documentsArray = Array.from(this.documents.values());
    await fs.writeFile(
      this.documentsPath,
      JSON.stringify(documentsArray, null, 2),
    );
  }

  async createDocument(title: string, content: string = ""): Promise<Document> {
    const now = new Date().toISOString();
    const document: Document = {
      id: uuidv4(),
      title,
      content,
      type: "document",
      createdAt: now,
      updatedAt: now,
      tags: [],
      favorite: false,
      preview: content.slice(0, 200),
    };

    this.documents.set(document.id, document);
    await this.saveDocuments();

    console.log(
      `[DocumentService] Created document: ${document.id} - ${title}`,
    );
    return document;
  }

  async getDocument(id: string): Promise<Document | null> {
    return this.documents.get(id) || null;
  }

  async updateDocument(
    id: string,
    updates: Partial<Omit<Document, "id" | "type" | "createdAt">>,
  ): Promise<Document | null> {
    const document = this.documents.get(id);
    if (!document) return null;

    const updatedDoc: Document = {
      ...document,
      ...updates,
      updatedAt: new Date().toISOString(),
      preview: updates.content
        ? updates.content.slice(0, 200)
        : document.preview,
    };

    this.documents.set(id, updatedDoc);
    await this.saveDocuments();

    console.log(`[DocumentService] Updated document: ${id}`);
    return updatedDoc;
  }

  async deleteDocument(id: string): Promise<boolean> {
    const existed = this.documents.delete(id);
    if (existed) {
      await this.saveDocuments();
      console.log(`[DocumentService] Deleted document: ${id}`);
    }
    return existed;
  }

  async listDocuments(): Promise<Document[]> {
    return Array.from(this.documents.values()).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async searchDocuments(query: string): Promise<Document[]> {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.documents.values()).filter(
      (doc) =>
        doc.title.toLowerCase().includes(lowerQuery) ||
        doc.content.toLowerCase().includes(lowerQuery) ||
        doc.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery)),
    );
  }

  async toggleFavorite(id: string): Promise<Document | null> {
    const document = this.documents.get(id);
    if (!document) return null;

    document.favorite = !document.favorite;
    document.updatedAt = new Date().toISOString();

    this.documents.set(id, document);
    await this.saveDocuments();

    return document;
  }
}

/**
 * Get or create DocumentService singleton
 */
export function getDocumentService(): DocumentService {
  if (!documentServiceInstance) {
    documentServiceInstance = new DocumentService();
  }
  return documentServiceInstance;
}

/**
 * Initialize DocumentService
 */
export async function initializeDocumentService(): Promise<DocumentService> {
  const service = getDocumentService();
  await service.initialize();
  return service;
}
