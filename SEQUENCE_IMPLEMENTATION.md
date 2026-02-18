# V1-Style Sequence Implementation for Interleaved Text and Tool Calls

**Date:** 2026-02-16
**Issue:** Messages show all text together, then all tool calls together. Should be interleaved: text → tool → text → tool

---

## Problem

Current V2 behavior:
```
[All agent narration text here]
Exploring:
  → tool 1
  → tool 2
  → tool 3
```

Desired V1 behavior:
```
Exploring:
  "Let me help you redesign..."
  → list apps
  "Found your app, let me read it..."
  → read_app_file
  → read_app_file  
  "Here's the redesign plan..."
```

## Solution

Implement V1's `sequence` array that preserves the order of text and tool calls as they arrive from the stream.

### Data Structure

```typescript
message.sequence = [
  { type: 'thinking', data: 'Let me think...' },
  { type: 'text', data: 'I can help you redesign...' },
  { type: 'tool', data: {name: 'list_apps', input: {...}, output: {...}, status: 'success'} },
  { type: 'text', data: 'Found your app, reading files...' },
  { type: 'tool', data: {name: 'read_app_file', ...} },
  { type: 'text', data: 'Here is the redesign plan...' }
]
```

### Changes Made

#### 1. Storage Layer (`IStorageProvider.ts`)
Added `sequence` field to `StoredMessage`:
```typescript
sequence?: Array<{
  type: 'text' | 'tool' | 'thinking';
  data: string | Record<string, any>;
}>;
```

#### 2. Stream Orchestrator (`streamOrchestrator.ts`)
- Added `currentTextSegment` to accumulate text between tool calls
- When `tool-call` arrives → flush `currentTextSegment` as text item, then add tool item
- When stream ends → add final `currentTextSegment` as text item
- Return `sequence` array in result

#### 3. Agent Service (`AgentService.ts`)
- Capture `sequence` from stream orchestrator result
- Pass `sequence` to message persistence
- Log sequence for debugging

#### 4. Message Persistence (`messagePersistence.ts`)
- Updated `createAssistantStoredMessage` to accept optional `sequence` parameter
- Include `sequence` in stored message

#### 5. Local Storage (`LocalStorageProvider.ts`)
- Added migration for `sequence` TEXT column (stores JSON)
- Updated INSERT to include `sequence`
- Updated SELECT to include `sequence`
- Parse `sequence` from JSON when loading messages

### UI Rendering (TODO)

The UI needs to be updated to render the sequence instead of showing all text then all tools:

**Current:**
```tsx
{thinking && <ThinkingCard />}
{toolCalls && <ExploringCard toolCalls={toolCalls} narration={content} />}
{content && <MessageText />}
```

**Should be:**
```tsx
{sequence ? (
  // V1-style rendering
  <RenderSequence sequence={sequence} />
) : (
  // Fallback for old messages
  <>
    {thinking && <ThinkingCard />}
    {toolCalls && <ExploringCard />}
    {content && <MessageText />}
  </>
)}
```

The `<RenderSequence>` component should:
1. Find first tool in sequence → create Exploring card
2. Iterate through sequence:
   - If `thinking` → add to thinking card
   - If `text` **before** any tool → add inside Exploring card (intro)
   - If `tool` → add tool item to Exploring card
   - If `text` **between** tools → add inside Exploring card (narration)
   - If `text` **after all** tools → add outside Exploring card (final response)

---

## Testing

1. Send a message that requires multiple tool calls with Gemini
2. Check terminal logs for sequence output
3. Verify sequence is saved to SQLite
4. Check that sequence has proper interleaving: text → tool → text → tool

Example log:
```
[AgentService] Sequence built: 5 items
  1. text: "I can help you redesign the app. Let me..."
  2. tool: list_apps
  3. text: "Found your app, reading files..."
  4. tool: read_app_file
  5. text: "Here is the redesign plan..."
```

---

## Next Steps

1. ✅ Backend sequence tracking implemented
2. ⏳ UI rendering to use sequence (MessageItem.tsx, ExploringCard.tsx)
3. ⏳ Handle old messages without sequence (fallback rendering)
