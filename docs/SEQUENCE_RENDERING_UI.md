# Sequence Rendering UI Implementation

**Date:** 2026-02-16  
**Status:** ✅ Complete

## Overview

Implemented V1-style sequence rendering in the UI to display **interleaved text and tool calls** (e.g., `text → tool → text → tool`) instead of grouping all text together and all tools together.

This applies to **all AI models** (Claude, OpenAI, Google Gemini, etc.), not just Gemini.

---

## Problem

Previously, messages were displayed as:
```
[All text responses grouped]
[All tool calls grouped in Exploring card]
```

Expected behavior (V1-style):
```
Text response 1
→ Tool call 1
Text response 2
→ Tool call 2
Final text
```

---

## Solution

### Backend (Already Complete - see SEQUENCE_IMPLEMENTATION.md)

1. **Data Structure:** Added `sequence` field to `StoredMessage`:
   ```typescript
   sequence?: Array<{
     type: 'text' | 'tool' | 'thinking';
     data: string | Record<string, any>;
   }>;
   ```

2. **Tracking:** `streamOrchestrator.ts` builds the sequence by:
   - Accumulating text in `currentTextSegment`
   - Flushing text before each tool call
   - Adding tool calls with their results
   - Adding thinking segments

3. **Persistence:** Sequence is saved to SQLite and loaded with messages.

### Frontend (This Update)

#### 1. Type Updates

**`ui/types/chat.ts`:**
```typescript
export interface ChatMessage extends CoreMessage {
  id: string;
  isStreaming?: boolean;
  streamingContent?: string;
  
  // V1-style sequence for interleaving text and tool calls
  sequence?: Array<{
    type: 'text' | 'tool' | 'thinking';
    data: string | Record<string, any>;
  }>;
}
```

**`ui/utils/historyMapper.ts`:**
- Added parsing of `sequence` field when loading messages from storage
- Preserves sequence for interleaved rendering

#### 2. Rendering Logic

**`ui/components/Chat/MessageItem.tsx`:**

Added `renderSequence()` function that:

1. **Extracts thinking** (if present) and renders at top
2. **Processes sequence items**:
   - **Text before/between tools** → Inside Exploring card as narration
   - **Final text (no tools after)** → Outside Exploring card
   - **Tool calls** → Displayed as `→ Tool name ✓`
3. **Handles old messages** (no sequence) → Falls back to old rendering

**Rendering flow:**
```tsx
if (message.sequence && message.sequence.length > 0) {
  renderSequence(message.sequence);
} else {
  // Fallback: old format (thinking → tools → text)
}
```

#### 3. Auto-Open App Edits

**`ui/hooks/useAgent.ts`:**

Fixed missing auto-open for `edit_app_file`:

**Before:** Only `create_document`, `import_document`, `create_app` triggered auto-open

**After:** Added `edit_app_file` and `update_app` to auto-open logic

**Behavior:**
- **Create/Import:** Parse `docId` from tool result, create new tab
- **Edit:** Extract `appId` from tool args, refresh existing tab or create if missing

---

## Example Sequence Rendering

### Input (from backend):
```json
{
  "sequence": [
    { "type": "thinking", "data": "Let me analyze the code..." },
    { "type": "text", "data": "I'll start by reading the app files." },
    { "type": "tool", "data": { "name": "list_app_files", "input": {...}, "output": "...", "status": "success" } },
    { "type": "text", "data": "Now I'll edit the main file." },
    { "type": "tool", "data": { "name": "edit_app_file", "input": {...}, "output": "...", "status": "success" } },
    { "type": "text", "data": "All done! The app is updated." }
  ]
}
```

### Output (UI):
```
┌──────────────────────────────────┐
│ 🧠 Thinking                      │
│ Let me analyze the code...       │
└──────────────────────────────────┘

┌──────────────────────────────────┐
│ ▼ Exploring                      │
├──────────────────────────────────┤
│ I'll start by reading the app    │
│ files.                            │
│                                   │
│ → Files listed ✓                 │
│                                   │
│ Now I'll edit the main file.     │
│                                   │
│ → File edited ✓                  │
└──────────────────────────────────┘

All done! The app is updated.
```

---

## Testing

### Manual Testing Steps

1. **New messages with sequence:**
   - Send a message that triggers multiple tool calls
   - Verify text appears **between** tool calls, not after all tools
   - Check that thinking appears at the top

2. **Old messages (no sequence):**
   - Load existing chats from before this update
   - Verify fallback rendering works (thinking → tools → text)

3. **App edit auto-open:**
   - Ask agent to edit an app file
   - Verify the app tab opens/refreshes automatically

### Example Prompts

- "List all apps, then read the Reddit app files, then update the main component"
- "Create a new todo app, then edit the App.tsx file to add a header"

---

## Files Changed

### Backend (Already Complete)
- ✅ `src/gateway/services/agent/streamOrchestrator.ts`
- ✅ `src/gateway/services/AgentService.ts`
- ✅ `src/gateway/services/agent/messagePersistence.ts`
- ✅ `src/gateway/services/storage/LocalStorageProvider.ts`
- ✅ `src/gateway/services/storage/IStorageProvider.ts`

### Frontend (This Update)
- ✅ `ui/types/chat.ts` - Added `sequence` to `ChatMessage`
- ✅ `ui/utils/historyMapper.ts` - Parse sequence from storage
- ✅ `ui/components/Chat/MessageItem.tsx` - Render sequence with `renderSequence()`
- ✅ `ui/hooks/useAgent.ts` - Fixed auto-open for `edit_app_file`

---

## Next Steps

### Streaming Sequence Support (Future)

Currently, the sequence is built **after** streaming completes. For real-time sequence updates during streaming:

1. Update `useAgent.ts` to track `currentSequence` during streaming
2. Flush text segments on each `tool-call` event
3. Update UI in real-time as sequence grows

**Trade-off:** More complex state management vs. instant feedback

**Decision:** Not needed for V2.0 - current approach works well

---

## Compatibility

- **Old messages** (no `sequence` field) → Falls back to legacy rendering
- **All models** → Sequence applies to Claude, OpenAI, Gemini, etc.
- **Migration** → No migration needed, new messages automatically get sequence

---

## Performance

**Impact:** Minimal
- Sequence is built once during orchestration
- Rendering is O(n) where n = sequence length
- No additional API calls or re-renders

**Memory:** Sequence data is ~same size as separate `content` + `toolCalls` fields

---

## Learnings

1. **V1 had it right:** Sequence-based rendering is cleaner than post-processing
2. **Fallback is critical:** Must support old messages without sequence
3. **Text placement matters:** Text between tools goes inside Exploring card, final text goes outside
4. **Auto-open needs all tools:** Don't forget `edit_app_file`, `update_app`, etc.

---

**This document is living documentation. Update as implementation evolves.**
