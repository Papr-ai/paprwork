# Tool Display UX Improvements

**Date:** 2026-03-02  
**Status:** ✅ Implemented

## Problem

Tool calls in the chat UI showed generic status messages like "Running" / "Ran" without contextual information. This made it hard to understand what the agent was actually doing, especially for:
- Web searches (couldn't see which domain was being searched)
- Browser navigation (couldn't see the target URL)
- File operations (couldn't see which file)
- Search operations (couldn't see the search query)

**Example before:**
```
→ Running        ✓  (for browser_navigate)
→ Ran            ✓  (for bash curl command)
```

## Solution

Enhanced the `getToolDisplayLabel()` function in `ui/utils/toolDisplay.ts` to extract and display contextual information from tool arguments:

### 1. Browser Navigation - Show Domain
```typescript
if (toolName === "browser_navigate" && typeof toolCall.args?.url === "string") {
  const url = toolCall.args.url as string;
  try {
    const domain = new URL(url).hostname.replace(/^www\./, "");
    return isRunning ? `Navigating to ${domain}` : `Navigated to ${domain}`;
  } catch {
    return isRunning ? "Navigating browser" : "Browser navigated";
  }
}
```

**Result:**
- `Navigating to bing.com` (running)
- `Navigated to bing.com` (completed)

### 2. Browser Type - Show Text Snippet
```typescript
if (toolName === "browser_type" && typeof toolCall.args?.text === "string") {
  const text = (toolCall.args.text as string).substring(0, 20);
  return isRunning 
    ? `Typing "${text}"${text.length > 20 ? "..." : ""}` 
    : "Text entered";
}
```

**Result:**
- `Typing "search query tex..."` (running)
- `Text entered` (completed)

### 3. File Search - Show Query
```typescript
if (toolName === "search_files" && typeof toolCall.args?.query === "string") {
  const query = (toolCall.args.query as string).substring(0, 30);
  return isRunning 
    ? `Searching for "${query}"${query.length > 30 ? "..." : ""}`
    : `Searched for "${query}"${query.length > 30 ? "..." : ""}`;
}
```

**Result:**
- `Searching for "AuthService"` (running)
- `Searched for "AuthService"` (completed)

### 4. Memory Search - Show Query
```typescript
if (toolName === "search_agent_memory" && typeof toolCall.args?.query === "string") {
  const query = (toolCall.args.query as string).substring(0, 30);
  return isRunning 
    ? `Searching memory for "${query}"${query.length > 30 ? "..." : ""}`
    : `Found in memory`;
}
```

**Result:**
- `Searching memory for "previous conversations"` (running)
- `Found in memory` (completed)

### 5. File Operations - Show Filename
```typescript
if ((toolName === "read_file" || toolName === "write_file") && typeof toolCall.args?.path === "string") {
  const filename = getDisplayFilename(toolCall.args.path as string);
  if (filename) {
    return toolName === "read_file"
      ? (isRunning ? `Reading ${filename}` : `Read ${filename}`)
      : (isRunning ? `Writing ${filename}` : `Wrote ${filename}`);
  }
}
```

**Result:**
- `Reading config.json` (running)
- `Read config.json` (completed)

### 6. Directory Listing - Show Directory
```typescript
if (toolName === "list_directory" && typeof toolCall.args?.path === "string") {
  const dirname = getDisplayFilename(toolCall.args.path as string) || "directory";
  return isRunning ? `Listing ${dirname}` : `Listed ${dirname}`;
}
```

**Result:**
- `Listing src/components` (running)
- `Listed src/components` (completed)

## Files Changed

- **`ui/utils/toolDisplay.ts`** - Enhanced `getToolDisplayLabel()` function with contextual parsing

## Benefits

1. **Better Transparency**: Users can see exactly what the agent is doing without clicking into tool details
2. **Web Search Context**: When searching the web, users see the domain (e.g., "Navigating to bing.com")
3. **File Context**: When reading/writing files, users see the filename
4. **Search Context**: When searching, users see the query
5. **Consistent UX**: All tool calls now provide meaningful context

## Testing

Build succeeded with no linter errors:
```bash
npm run build:ui
# ✓ built in 2.21s
```

## Before/After Example

### Before
```
Working ▼
  → Running        ✓
  → Ran            ✓
  → Running        ✓
  → Ran            ✓
```

### After
```
Working ▼
  → Navigating to bing.com        ✓
  → Navigated to bing.com         ✓
  → Searching for "Chime AI"      ✓
  → Searched for "Chime AI"       ✓
```

## Future Enhancements

Potential future improvements:
- Show bash command descriptions for curl (already implemented)
- Show job names for `run_job` (already implemented via JobStatusCard)
- Show delegation tasks (already implemented via DelegationCard/MiniChatCard)
- Show plan steps (already implemented via PlanCard)

## Related

- `ui/components/Chat/MessageItem.tsx` - Consumes `getToolDisplayLabel()`
- `ui/components/Chat/ExploringCard.tsx` - Also uses `getToolDisplayLabel()`
- `docs/JOB_DELEGATION_CARD_UX_IMPROVEMENTS.md` - Related UX improvements for delegation cards
