---
id: preloaded-document-system
name: Document System
description: Create, read, and manage Papr documents stored as Markdown on disk with version history and DOCX export.
---
# Document System (V2)

Papr documents are Markdown files stored on disk at `~/Papr/documents/{docId}/content.md`. The UI auto-syncs changes via file watching.

## Tools

| Tool | Purpose |
|------|---------|
| `create_document` | Create a new document with title and optional content |
| `read_document` | Read a document's content by ID |
| `list_documents` | List all documents with metadata |
| `import_document` | Import a file from the user's device as a Papr document |

## Creating Documents

```javascript
create_document({
  title: "Q1 Marketing Plan",
  content: "# Q1 Marketing Plan\n\n## Goals\n\n- Increase MQLs by 30%\n..."
})
```

The document opens automatically in a split view alongside the chat. The agent can continue editing via `bash` to modify the Markdown file directly.

## Tables in documents

The in-app editor supports **GitHub-style pipe tables**. For side-by-side comparisons (schemas, modes, APIs):

- Header row, then `|---|` separator row, then body rows — one row per dimension (Mode, Purpose, Risk, etc.).
- Keep each cell readable: separate values with commas (`manual`, `auto`), not run-together text (`manualauto`).
- Avoid one long line of `**labels**` and `` `code` `` only; prefer a table or `###` + bullet lists.

## Editing Documents

Agents edit documents by modifying the Markdown file with `bash`:

```bash
# Append content
echo "\n## New Section\n\nContent here..." >> ~/Papr/documents/{docId}/content.md

# Replace specific content
sed -i '' 's/old text/new text/g' ~/Papr/documents/{docId}/content.md
```

The UI watches the file and auto-updates when changes are detected.

## Document Structure on Disk

```
~/Papr/documents/{docId}/
  content.md          # The document content (Markdown)
  meta.json           # Metadata (title, dates, tags, word count)
  versions/           # Version history snapshots
    v1_2026-02-13.md
    v2_2026-02-13.md
```

### meta.json Format
```json
{
  "id": "document-id",
  "title": "Document Title",
  "type": "document",
  "createdAt": "2026-02-13T10:00:00Z",
  "updatedAt": "2026-02-13T10:30:00Z",
  "tags": ["marketing", "q1"],
  "favorite": false,
  "preview": "First 200 characters...",
  "wordCount": 1500
}
```

## Important: Always Use `create_document`

**Always** use `create_document` for new documents. Never write DOCX files directly — users can export any document to DOCX from the editor toolbar when they need a Word file.

To import an external file (including `.docx`) into Papr, use `import_document`. DOCX files are automatically converted to Markdown during import.

## Importing Documents

Users can import existing files from their device:

```javascript
// Import a Markdown or text file
import_document({ filePath: "~/Documents/notes.md" })

// Import a Word document (auto-converted to Markdown)
import_document({ filePath: "~/Downloads/report.docx", title: "Q4 Report" })
```

Supported formats:
- **Markdown** (`.md`, `.markdown`) — imported as-is
- **Text** (`.txt`) — imported as-is
- **Word** (`.docx`) — converted to Markdown via mammoth

The imported file is copied into the Papr document structure with version tracking. The original file path is preserved in metadata.

## Version History

Documents have automatic version history. Snapshots are saved in the `versions/` directory when significant changes are detected.

## DOCX Export

Documents can be exported to Microsoft Word format (.docx) from the document editor toolbar. This is a user-initiated action — agents do not need to handle DOCX creation.

## Best Practices

### When Creating Documents
- Use descriptive titles — they become the folder name
- Start with a clear heading structure (H1, H2, H3)
- Include all content in the initial `create_document` call when possible
- For large documents, create with outline first, then fill sections with `bash`

### When Editing
- Use `bash` to modify the Markdown file directly
- The UI auto-syncs — no need to reload
- Save versions before major rewrites

### Document Organization
- Use tags for categorization
- Favorite important documents for quick access
- Documents appear in the Artifacts view in the sidebar

## Markdown Features Supported
- Headings (H1-H6)
- Bold, italic, strikethrough
- Ordered and unordered lists
- Task lists (checkboxes)
- Code blocks with syntax highlighting
- Tables
- Links and images
- Block quotes
- Horizontal rules
- LaTeX math (inline and block)
