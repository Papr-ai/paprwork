# Line-Based App File Editing Implementation

**Date:** 2026-02-20  
**Status:** ✅ Implemented and Tested

## Problem

The `edit_app_file` tool uses exact string matching, which is fragile:
- Fails if string doesn't match character-for-character (whitespace, newlines, etc.)
- Poor error messages when matching fails
- Agent had to fall back to bash `sed` commands (security risk)
- No way to know which occurrence gets replaced when string appears multiple times

**Example failure:**
```javascript
edit_app_file({
  appId: "abc-123",
  filename: "index.html",
  oldString: "<div class='planner-box'>...", // Multi-line string with exact whitespace
  newString: "..."
})
// ❌ Fails if whitespace doesn't match exactly
```

## Solution

Added `edit_app_file_lines` tool that uses **line-based editing** (like Cursor's StrReplace):

```javascript
// 1. Read file to see line numbers
read_app_file({ appId: "abc-123", filename: "index.html" })

// 2. Replace lines by number (unambiguous)
edit_app_file_lines({
  appId: "abc-123",
  filename: "index.html",
  startLine: 168,
  endLine: 215,
  newContent: `    <div class="new-structure">
      <span>New content</span>
    </div>`
})
```

## Implementation

### Files Changed

1. **`src/core/tools/appJobs.ts`**
   - Added `editAppFileLinesSchema` (Zod schema)
   - Added `editAppFileLinesTool` implementation
   - Exported in `appJobsTools` array

2. **`src/core/tools/index.ts`**
   - Exported `editAppFileLinesTool`

3. **`src/core/agents/SystemPrompt.ts`**
   - Updated tool reference table
   - Added guidance on when to use which editing tool

4. **`src/resources/agent-docs/APP_AND_JOBS_GUIDE.md`**
   - Updated tools reference table
   - Added "Editing App Files: Which Tool to Use?" section with decision tree

### Tool Interface

```typescript
interface EditAppFileLinesArgs {
  appId: string;        // App UUID
  filename: string;     // e.g. "index.html", "style.css", "app.js"
  startLine: number;    // 1-indexed, inclusive
  endLine: number;      // 1-indexed, inclusive
  newContent: string;   // Replacement content (empty string to delete)
}
```

### Features

- ✅ **Line number validation** - Checks bounds before editing
- ✅ **Clear error messages** - Shows file length, suggests using `read_app_file`
- ✅ **Change metrics** - Returns lines added/removed/net change
- ✅ **Helpful tips** - Warns when line numbers shift after edit
- ✅ **Safe operations** - No shell escaping, no regex, no ambiguity

### Return Value

```typescript
{
  success: true,
  data: {
    filename: "index.html",
    updated: true,
    originalLines: 250,
    newLines: 237,
    linesRemoved: 16,
    linesAdded: 3,
    netChange: -13,
    tip: "File now has 237 lines (-13). Line numbers after 168 have shifted."
  }
}
```

## Usage Guidelines

### When to Use `edit_app_file_lines` (RECOMMENDED)

- ✅ Editing HTML structure
- ✅ Modifying JavaScript functions
- ✅ Updating CSS blocks
- ✅ Any multi-line code changes
- ✅ When string matching is unreliable

### When to Use `edit_app_file` (Legacy)

- ✅ Simple one-line text replacements
- ✅ Changing a URL or constant that appears once
- ✅ Quick variable value updates
- ⚠️ Only if you're 100% sure the string matches exactly

### Workflow

```javascript
// RECOMMENDED WORKFLOW
// 1. List apps to find existing app
list_apps()

// 2. Read file to see current content with line numbers
read_app_file({ appId: "abc-123", filename: "index.html" })
// Output shows: "168|    <div class='old-structure'>..."

// 3. Replace specific line range
edit_app_file_lines({
  appId: "abc-123",
  filename: "index.html",
  startLine: 168,
  endLine: 215,
  newContent: "... new content ..."
})

// 4. Verify with webview or read again
webview_snapshot({ appId: "abc-123" })
```

## Benefits

### For Agent

- ✅ **No more string matching failures** - Line numbers never lie
- ✅ **Better error messages** - "Line 500 doesn't exist (file has 300 lines)"
- ✅ **No bash fallback needed** - Structured tool handles it
- ✅ **Change tracking** - Knows how line numbers shifted

### For Security

- ✅ **No shell injection** - Pure TypeScript operations
- ✅ **Validated inputs** - Zod schema enforces types
- ✅ **Path safety** - Uses AppService (already has path validation)

### For Reliability

- ✅ **Cross-platform** - No macOS vs Linux sed differences
- ✅ **Predictable** - Same behavior every time
- ✅ **Testable** - Can mock AppService easily

## Testing

Validated:
- ✅ Tool structure and schema
- ✅ Line replacement logic (unit test)
- ✅ TypeScript compilation passes
- ✅ No linter errors

Ready for agent use.

## Migration Path

**Keep both tools:**
- `edit_app_file` - For simple text replacements (backward compatibility)
- `edit_app_file_lines` - For all code editing (recommended going forward)

**Agent will naturally prefer `edit_app_file_lines` because:**
1. System prompt now recommends it
2. Better error messages guide agent to use it
3. More reliable = fewer retries = faster completion

## Next Steps (Optional Enhancements)

### 1. Add Multi-Range Editing
```typescript
edit_app_file_lines({
  appId: "...",
  filename: "...",
  edits: [
    { startLine: 10, endLine: 15, newContent: "..." },
    { startLine: 50, endLine: 60, newContent: "..." },
    { startLine: 100, endLine: 105, newContent: "..." }
  ]
})
```

### 2. Add Diff Preview
```typescript
edit_app_file_lines({
  appId: "...",
  filename: "...",
  startLine: 10,
  endLine: 20,
  newContent: "...",
  preview: true  // Return diff without applying
})
```

### 3. Add Insert/Append Operations
```typescript
insert_app_file_lines({
  appId: "...",
  filename: "...",
  afterLine: 50,  // Insert after line 50
  content: "..."
})
```

### 4. Add the same for Job Files
Implement `edit_job_file_lines` following the same pattern as `edit_app_file_lines`.

## Related

- See `CLAUDE.md` - Issue #7 documented the original problem
- See `APP_AND_JOBS_GUIDE.md` - Full documentation for app/job tools
- See `src/core/tools/appJobs.ts` - Complete implementation

---

**Outcome:** Agent can now reliably edit app files without falling back to bash commands. String matching issues are eliminated by using unambiguous line numbers instead.
