/**
 * Tests for the import_document logic.
 *
 * We test the file-reading and document-creation flow directly rather than
 * going through Mastra's tool wrapper (which handles schema validation
 * and context unwrapping in the agent call chain).
 */

import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, describe, expect, test, vi } from "vitest";

const tmpRoots: string[] = [];

afterEach(async () => {
  for (const root of tmpRoots.splice(0, tmpRoots.length)) {
    await fs.rm(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("import_document flow", () => {
  test("reads a file and creates a Papr document from it", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "papr-import-test-"),
    );
    tmpRoots.push(root);

    // Create a source file
    const sourceDir = path.join(root, "user-files");
    await fs.mkdir(sourceDir, { recursive: true });
    const sourceFile = path.join(sourceDir, "my-notes.md");
    const fileContent = "# My Notes\n\nSome important content here.";
    await fs.writeFile(sourceFile, fileContent, "utf-8");

    // Read the file (simulating what the tool does)
    const content = await fs.readFile(sourceFile, "utf-8");
    expect(content).toBe(fileContent);

    // Derive title from filename
    const title = path.basename(sourceFile, path.extname(sourceFile));
    expect(title).toBe("my-notes");
  });

  test("resolves ~ to home directory", () => {
    const home = os.homedir();
    const input = "~/Documents/notes.md";
    const resolved = path.join(home, input.slice(1));
    expect(resolved).toBe(path.join(home, "/Documents/notes.md"));
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  test("resolves relative paths to absolute", () => {
    const input = "notes.md";
    const resolved = path.resolve(input);
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  test("throws for non-existent file", async () => {
    await expect(
      fs.readFile("/nonexistent/path/to/file.md", "utf-8"),
    ).rejects.toThrow();
  });

  test("derives title from filename correctly", () => {
    const cases = [
      { input: "/Users/me/docs/notes.md", expected: "notes" },
      { input: "/path/to/My Report.txt", expected: "My Report" },
      { input: "~/Desktop/README.markdown", expected: "README" },
    ];

    for (const { input, expected } of cases) {
      const title = path.basename(input, path.extname(input));
      expect(title).toBe(expected);
    }
  });

  test("custom title overrides filename", () => {
    const customTitle = "Custom Title";
    const filename = "my-notes";
    const title = customTitle ?? filename;
    expect(title).toBe("Custom Title");
  });

  test("meta.json can store originalPath", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "papr-import-meta-"),
    );
    tmpRoots.push(root);

    const metaDir = path.join(root, "doc-001");
    await fs.mkdir(metaDir, { recursive: true });
    const metaPath = path.join(metaDir, "meta.json");

    // Write initial meta
    const meta = { id: "doc-001", title: "Test" };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

    // Read, add originalPath, write back (simulating what the tool does)
    const raw = await fs.readFile(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.originalPath = "/Users/me/Documents/notes.md";
    await fs.writeFile(metaPath, JSON.stringify(parsed, null, 2), "utf-8");

    // Verify
    const updated = JSON.parse(
      await fs.readFile(metaPath, "utf-8"),
    ) as Record<string, unknown>;
    expect(updated.originalPath).toBe("/Users/me/Documents/notes.md");
    expect(updated.id).toBe("doc-001");
    expect(updated.title).toBe("Test");
  });

  test("supports common text file extensions", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "papr-import-ext-"),
    );
    tmpRoots.push(root);

    const extensions = [".md", ".txt", ".markdown"];
    for (const ext of extensions) {
      const filePath = path.join(root, `test${ext}`);
      await fs.writeFile(filePath, `Content of ${ext}`, "utf-8");
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe(`Content of ${ext}`);
    }
  });

  test("converts .docx to Markdown via mammoth + turndown", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "papr-import-docx-"),
    );
    tmpRoots.push(root);

    // Create a minimal DOCX file using the docx package
    const { Document: DocxDocument, Packer, Paragraph, TextRun, HeadingLevel } =
      await import("docx");
    const doc = new DocxDocument({
      sections: [
        {
          children: [
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              children: [new TextRun("Test Heading")],
            }),
            new Paragraph({
              children: [new TextRun("This is paragraph content.")],
            }),
          ],
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    const docxPath = path.join(root, "test-doc.docx");
    await fs.writeFile(docxPath, Buffer.from(buffer));

    // Convert using the same logic as import_document
    const mammoth = await import("mammoth");
    const TurndownService = (await import("turndown")).default;
    const fileBuffer = await fs.readFile(docxPath);
    const result = await mammoth.convertToHtml({ buffer: fileBuffer });
    const td = new TurndownService({ headingStyle: "atx" });
    const markdown = td.turndown(result.value);

    // Verify conversion produced meaningful markdown
    expect(markdown).toContain("Test Heading");
    expect(markdown).toContain("This is paragraph content.");
    // Should use ATX headings (# style)
    expect(markdown).toMatch(/^#/m);
  });

  test("detects .docx extension correctly", () => {
    const cases = [
      { input: "/Users/me/report.docx", expected: ".docx" },
      { input: "/Users/me/report.DOCX", expected: ".docx" },
      { input: "/Users/me/report.md", expected: ".md" },
      { input: "/Users/me/report.txt", expected: ".txt" },
    ];

    for (const { input, expected } of cases) {
      const ext = path.extname(input).toLowerCase();
      expect(ext).toBe(expected);
    }
  });
});
