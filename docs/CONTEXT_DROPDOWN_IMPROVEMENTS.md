# Context Dropdown Improvements

**Date:** 2026-03-12  
**Status:** ✅ Implemented

---

## Overview

Improved the context dropdown to be more compact (matching ChatHistoryDropdown design) and added file attachment/upload functionality so users can easily add files to chat context.

---

## Changes

### 1. Compact Design Matching ChatHistoryDropdown

**Before:**
- Large dropdown with excessive padding
- Separate header section
- Verbose styling with CSS variables

**After:**
- Compact 320px width (same as ChatHistoryDropdown)
- Minimal padding (8px, 6px 10px)
- Consistent dark theme (#1e1e1e background, #3e3e3e borders)
- Same visual hierarchy and spacing

**Files Changed:**
- `ui/components/Chat/ContextDropdown.css` - Redesigned to match ChatHistoryDropdown
- `ui/components/Chat/ContextDropdown.tsx` - Updated class names

### 2. File Attachment/Upload Feature

Added "Attach or Upload File" button below search that allows users to:
- Navigate their file system
- Select one or multiple files
- Attach files to chat context
- LLM receives file path and can read using `read_file` tool

**UI Changes:**
```
┌─ Context Dropdown ────────┐
│ [Search...]              │  ← Search input
│ ──────────────────────── │
│ [📤 Attach or Upload File]│  ← NEW: File upload button
│ ──────────────────────── │
│ 📄 Document 1            │  ← Artifact list
│ 📱 App 1                 │
└──────────────────────────┘
```

**Implementation:**

```typescript
// Hidden file input
<input
  ref={fileInputRef}
  type="file"
  multiple
  style={{ display: "none" }}
  onChange={handleFileUpload}
  accept=".txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.java,..."
/>

// Upload button triggers file picker
<button onClick={() => fileInputRef.current?.click()}>
  Attach or Upload File
</button>
```

**File Processing:**
```typescript
const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const files = e.target.files;
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    // Get file path (available in Electron)
    const filePath = (file as any).path || file.name;
    
    // Create artifact with file metadata
    const fileArtifact: Artifact = {
      id: `file-${Date.now()}-${i}`,
      title: file.name,
      type: "document",
      content: `File path: ${filePath}`,
      metadata: {
        filePath,
        fileSize: file.size,
        fileType: file.type || "unknown",
      },
      // ... other fields
    };
    
    onSelectArtifact(fileArtifact);
  }
};
```

### 3. Artifact Type Enhancement

Added `metadata` and `content` fields to `Artifact` interface:

```typescript
export interface Artifact {
  id: string;
  title: string;
  type: ArtifactType;
  createdAt: string;
  updatedAt: string;
  content?: string;  // NEW: Content (e.g., file path info)
  preview?: string;
  icon?: string;
  favorite?: boolean;
  tags?: string[];
  wordCount?: number;
  metadata?: {  // NEW: Metadata for files and other context
    filePath?: string;
    fileSize?: number;
    fileType?: string;
    [key: string]: any;
  };
}
```

### 4. LLM Context Formatting

Updated `ChatContainer.tsx` to format attached artifacts for the LLM:

```typescript
const handleSendMessage = useCallback(
  async (message: string, contextArtifacts?: Artifact[]) => {
    // Format context artifacts (including file uploads) for LLM
    let artifactsContext = "";
    if (contextArtifacts && contextArtifacts.length > 0) {
      artifactsContext = "\n\n## Attached Context\n";
      for (const artifact of contextArtifacts) {
        artifactsContext += `\n### ${artifact.title}\n`;
        artifactsContext += `Type: ${artifact.type === "document" ? "Document" : "App"}\n`;
        
        // Include file path if this is a file upload
        if (artifact.metadata?.filePath) {
          artifactsContext += `File Path: ${artifact.metadata.filePath}\n`;
          if (artifact.metadata.fileType) {
            artifactsContext += `File Type: ${artifact.metadata.fileType}\n`;
          }
          artifactsContext += `\nThe user has attached this file. You can read it using the read_file tool with the file path provided above.\n`;
        } else if (artifact.content) {
          // Include content for non-file artifacts
          artifactsContext += `\n${artifact.content}\n`;
        }
      }
    }

    // Add to system prompt
    const config = {
      // ...
      systemPrompt: DEFAULT_SYSTEM_PROMPT + mergedContext + artifactsContext,
    };
  },
  [/* deps */]
);
```

---

## Usage Example

### User Workflow

1. **Open context dropdown** - Click "Add Context" button in input bar
2. **Upload a file** - Click "Attach or Upload File" button
3. **Select file(s)** - System file picker opens
4. **File appears as pill** - Below input, shows filename
5. **Send message** - LLM receives file path and instructions to read it

### LLM Receives

```
## Attached Context

### config.json
Type: Document
File Path: /Users/username/project/config.json
File Type: application/json

The user has attached this file. You can read it using the read_file tool with the file path provided above.
```

### LLM Can Then

```typescript
// Call read_file tool
read_file({
  path: "/Users/username/project/config.json"
})

// Returns file contents
{
  "database": "postgres",
  "port": 5432,
  // ...
}
```

---

## Supported File Types

```typescript
accept=".txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.h,.css,.html,.xml,.yaml,.yml,.sh,.sql,.go,.rs,.rb,.php,.swift,.kt"
```

**Categories:**
- **Text:** .txt, .md
- **Data:** .json, .xml, .yaml, .yml
- **Code:** .js, .ts, .tsx, .jsx, .py, .java, .c, .cpp, .h, .go, .rs, .rb, .php, .swift, .kt
- **Web:** .css, .html
- **Scripts:** .sh, .sql

---

## Design Consistency

### ChatHistoryDropdown vs ContextDropdown

| Property | ChatHistoryDropdown | ContextDropdown |
|----------|---------------------|-----------------|
| **Width** | 320px | 320px ✅ |
| **Background** | #1e1e1e | #1e1e1e ✅ |
| **Border** | 1px solid #3e3e3e | 1px solid #3e3e3e ✅ |
| **Border Radius** | 8px | 8px ✅ |
| **Search Padding** | 6px 10px | 6px 10px ✅ |
| **Item Height** | ~30px | ~30px ✅ |
| **Font Size** | 13px (title), 11px (meta) | 13px (title), 11px (meta) ✅ |
| **Hover BG** | #2a2a2a | #2a2a2a ✅ |

Both dropdowns now have **identical visual treatment**.

---

## Benefits

### For Users
1. ✅ **Faster context access** - Compact dropdown, easier to scan
2. ✅ **File attachments** - No need to copy/paste file contents
3. ✅ **Multiple files** - Select multiple files at once
4. ✅ **Visual consistency** - Matches chat history dropdown

### For LLM
1. ✅ **Direct file access** - Can read files using tools
2. ✅ **Metadata context** - Knows file type, size
3. ✅ **Clear instructions** - Told explicitly how to read files
4. ✅ **Multiple sources** - Can handle multiple attached files

---

## Edge Cases Handled

### 1. Large File Paths
- Ellipsis truncation in pills
- Full path passed to LLM (not truncated)

### 2. Multiple Files
- Each file gets unique ID (`file-${Date.now()}-${i}`)
- All files appear as separate pills
- All files included in context

### 3. File Without Path
- Electron provides `file.path` property
- Falls back to `file.name` if path unavailable
- Still creates artifact (may not be readable)

### 4. Unsupported File Types
- User can still select any file
- LLM receives path and can attempt to read
- `read_file` tool will handle errors

---

## Files Changed

1. ✅ `ui/components/Chat/ContextDropdown.tsx` - Added file upload
2. ✅ `ui/components/Chat/ContextDropdown.css` - Redesigned compact layout
3. ✅ `ui/stores/artifactsStore.ts` - Added `content` and `metadata` to Artifact
4. ✅ `ui/components/Chat/ChatContainer.tsx` - Format artifacts for LLM
5. ✅ `docs/CONTEXT_DROPDOWN_IMPROVEMENTS.md` - This documentation

---

## Testing

### Manual Test

1. Open chat
2. Click "Add Context" button
3. Verify dropdown opens compactly (320px)
4. Click "Attach or Upload File"
5. Select a .txt or .md file
6. Verify file appears as pill
7. Send message: "What's in this file?"
8. Verify LLM receives file path
9. Verify LLM can read file (if `read_file` tool available)

### Visual Comparison

Compare side-by-side:
- ChatHistoryDropdown (clock icon)
- ContextDropdown (+ icon)

Should look nearly identical in:
- Size and shape
- Colors and borders
- Search input styling
- Item spacing and hover states

---

## Future Enhancements

### Drag & Drop
```typescript
<div
  onDrop={handleDrop}
  onDragOver={(e) => e.preventDefault()}
>
  {/* Drag files here */}
</div>
```

### File Preview
- Show first few lines of text files
- Syntax highlighting for code
- Image thumbnails for images

### Batch Operations
- Remove all files at once
- Select specific file types
- Search within files

### Smart Suggestions
- Suggest recently opened files
- Suggest files from current project
- Suggest related documents

---

## Related Documentation

- `docs/CHAT_LIST_AUTO_UPDATE_FIX.md` - Chat list broadcast updates
- `docs/TITLE_GENERATION_ROUTING.md` - Title generation routing
- UI Component consistency standards
