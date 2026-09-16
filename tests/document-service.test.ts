import { beforeEach, describe, expect, test } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { DocumentService } from "../src/gateway/services/DocumentService.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("DocumentService", () => {
  // Owns HOME, os.homedir and the workspace pointer, so fixtures never land in
  // the developer's real ~/Papr. Setting process.env.HOME alone was not enough
  // — DocumentService resolves its paths via os.homedir().
  const workspace = useIsolatedPaprWorkspace("document-service");

  let testHomeDir: string;
  let documentService: DocumentService;

  beforeEach(async () => {
    testHomeDir = workspace.homeDir;
    documentService = new DocumentService();
    await documentService.initialize();
  });

  test("creates and retrieves documents", async () => {
    const created = await documentService.createDocument(
      "Plan",
      "Architecture migration details",
    );
    const loaded = await documentService.getDocument(created.id);

    expect(loaded).toBeDefined();
    expect(loaded?.title).toBe("Plan");
    expect(loaded?.content).toContain("Architecture");
    expect(loaded?.preview).toBe("Architecture migration details");
  });

  test("updates document content and preview", async () => {
    const created = await documentService.createDocument("Doc", "Old content");
    const updated = await documentService.updateDocument(created.id, {
      content: "New content for the updated preview",
    });

    expect(updated).toBeDefined();
    expect(updated?.content).toContain("New content");
    expect(updated?.preview).toContain("New content");
  });

  test("searches documents by title and body", async () => {
    await documentService.createDocument("Backend Guide", "Gateway details");
    await documentService.createDocument("UI Notes", "Renderer behavior");

    const byTitle = await documentService.searchDocuments("backend");
    const byBody = await documentService.searchDocuments("renderer");

    expect(byTitle).toHaveLength(1);
    expect(byTitle[0].title).toBe("Backend Guide");
    expect(byBody).toHaveLength(1);
    expect(byBody[0].title).toBe("UI Notes");
  });

  test("toggles favorite and deletes documents", async () => {
    const created = await documentService.createDocument("Fav", "Value");
    const toggled = await documentService.toggleFavorite(created.id);
    const deleted = await documentService.deleteDocument(created.id);
    const afterDelete = await documentService.getDocument(created.id);

    expect(toggled?.favorite).toBe(true);
    expect(deleted).toBe(true);
    expect(afterDelete).toBeNull();
  });

  test("uses slugified title as document ID", async () => {
    const created = await documentService.createDocument(
      "My Research Notes",
      "Content here",
    );
    // ID should be a slug, not a UUID
    expect(created.id).toBe("my-research-notes");
    expect(created.id).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("handles slug collisions by appending counter", async () => {
    const first = await documentService.createDocument(
      "Weekly Report",
      "First report",
    );
    const second = await documentService.createDocument(
      "Weekly Report",
      "Second report",
    );
    const third = await documentService.createDocument(
      "Weekly Report",
      "Third report",
    );

    expect(first.id).toBe("weekly-report");
    expect(second.id).toBe("weekly-report-2");
    expect(third.id).toBe("weekly-report-3");

    // All three should be independently retrievable
    const loaded1 = await documentService.getDocument(first.id);
    const loaded2 = await documentService.getDocument(second.id);
    const loaded3 = await documentService.getDocument(third.id);

    expect(loaded1?.content).toContain("First");
    expect(loaded2?.content).toContain("Second");
    expect(loaded3?.content).toContain("Third");
  });

  test("slugifies special characters and caps length", async () => {
    const created = await documentService.createDocument(
      "My Report: Q1 2026 (Final Draft!) & Updates",
      "",
    );
    // Special chars removed, spaces become hyphens
    expect(created.id).toBe("my-report-q1-2026-final-draft-updates");
    expect(created.id.length).toBeLessThanOrEqual(80);
  });

  test("falls back to 'untitled' for empty title", async () => {
    const created = await documentService.createDocument("!!!", "");
    // All non-word chars stripped, fallback to "untitled"
    expect(created.id).toBe("untitled");
  });

  test("repairs documents with content.md but missing meta.json", async () => {
    const docId = "agent-written-doc";
    const docDir = path.join(testHomeDir, "Papr", "documents", docId);
    await fs.mkdir(docDir, { recursive: true });
    await fs.writeFile(
      path.join(docDir, "content.md"),
      "# Agent Draft\n\nBody text for preview.",
      "utf-8",
    );

    const listed = await documentService.listDocuments();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(docId);
    expect(listed[0]?.title).toBe("Agent Draft");
    expect(listed[0]?.preview).toContain("Body text");

    const metaRaw = await fs.readFile(path.join(docDir, "meta.json"), "utf-8");
    expect(JSON.parse(metaRaw).title).toBe("Agent Draft");
  });

  /**
   * Archive is the reversible half of the archive/delete pair, so the flag has
   * to survive a reload — it is written to meta.json and read back through
   * normalizeDocumentMeta, which rebuilds the record field by field and drops
   * anything it does not explicitly name.
   *
   * No session token exists under test, so the Post hop short-circuits before
   * any network call and only the local half is exercised here.
   */
  test("archives a document and the flag survives a reload", async () => {
    const created = await documentService.createDocument(
      "Archivable",
      "Long enough to be a real document with content worth keeping.",
    );

    const archived = await documentService.archiveDocument(created.id);
    expect(archived?.archived).toBe(true);

    const reloaded = await documentService.getDocument(created.id);
    expect(reloaded?.archived).toBe(true);
  });

  test("restores an archived document", async () => {
    const created = await documentService.createDocument(
      "Restorable",
      "Long enough to be a real document with content worth keeping.",
    );
    await documentService.archiveDocument(created.id);

    const restored = await documentService.archiveDocument(created.id, false);
    expect(restored?.archived).toBe(false);

    // Absent and false are the same state on disk: normalization only carries
    // `archived` through when true, so a restored document reads back as
    // undefined rather than false. Either one means "not archived".
    const reloaded = await documentService.getDocument(created.id);
    expect(reloaded?.archived ?? false).toBe(false);
  });

  test("archiving does not bump updatedAt", async () => {
    // Archiving is a lifecycle change, not an edit. Bumping updatedAt would
    // make a restored document claim it was edited today and jump to the top
    // of the "Recent" sort.
    const created = await documentService.createDocument(
      "Timestamped",
      "Long enough to be a real document with content worth keeping.",
    );

    const archived = await documentService.archiveDocument(created.id);
    expect(archived?.updatedAt).toBe(created.updatedAt);
  });

  test("keeps archived documents in listDocuments", async () => {
    // The gateway does not hide them — the view decides. Filtering here would
    // make archived documents unreachable from every surface at once.
    const created = await documentService.createDocument(
      "Listed",
      "Long enough to be a real document with content worth keeping.",
    );
    await documentService.archiveDocument(created.id);

    const listed = await documentService.listDocuments();
    expect(listed.find((doc) => doc.id === created.id)?.archived).toBe(true);
  });

  test("archiving an unknown document resolves null rather than throwing", async () => {
    await expect(
      documentService.archiveDocument("no-such-document"),
    ).resolves.toBeNull();
  });

  test("deletes a document that never synced to a Post", async () => {
    // deleteDocument now calls deleteDocumentPost first. With no index entry
    // that must short-circuit to success and still remove the local files —
    // the Post hop must never become a precondition for local deletion.
    const created = await documentService.createDocument("Doomed", "Bye");

    await expect(documentService.deleteDocument(created.id)).resolves.toBe(true);
    await expect(documentService.getDocument(created.id)).resolves.toBeNull();
  });
});
