# Thinking & Actioning Cards Implementation

## Summary

Successfully implemented thinking and actioning cards matching Paprwork v1 design with Liquid Glass styling.

## Components Created

### 1. ThinkingCard (`ui/components/Chat/ThinkingCard.tsx`)
**Purpose**: Display AI reasoning/thinking process during message generation

**Features**:
- Collapsible card with expand/collapse chevron
- Zinc color scheme (rgba(161, 161, 170, ...)) matching v1
- Streaming support with animated cursor
- Smooth animations (fadeIn, transitions)
- "Thinking..." label during streaming
- Border-left accent line for content

**Styling**:
- Background: `rgba(161, 161, 170, 0.05)` - zinc-400 with 5% opacity
- Border: Subtle zinc with hover states
- Icon: Zinc-400 color with info circle SVG
- Cursor: Blinking cursor for streaming state

### 2. ActioningCard (`ui/components/Chat/ActioningCard.tsx`)
**Purpose**: Display tool calls/actions with status-based color coding

**Features**:
- Three states: `calling`, `success`, `error`
- Color-coded backgrounds and borders per state:
  - **Calling**: Blue (rgba(59, 130, 246, ...))
  - **Success**: Gray (rgba(156, 163, 175, ...))
  - **Error**: Red (rgba(239, 68, 68, ...))
- Animated spinner for "calling" state
- Tool-specific emojis (🔍 search, 🧠 memory, 🖼️ image, etc.)
- Result/error text display
- Pulse animation on calling state

**Tool Emoji Mapping**:
```typescript
search → 🔍
memory → 🧠
image  → 🖼️
code   → 💻
file   → 📄
web    → 🌐
calc   → 🔢
default → ⚡
```

## Type Updates

### `ui/types/core.ts`
Added new interfaces:
```typescript
interface ToolCall {
  id: string;
  toolName: string;
  args?: Record<string, unknown>;
  status: "calling" | "success" | "error";
  result?: string;
  error?: string;
}

interface CoreMessage {
  // ... existing fields
  reasoning?: string;
  streamingReasoning?: string;
  toolCalls?: ToolCall[];
}
```

## Hook Updates

### `ui/hooks/useAgent.ts`
Enhanced streaming chunk handling:

**New Refs**:
- `streamingReasoningRef` - Accumulates reasoning text
- `toolCallsMapRef` - Tracks active tool calls by ID

**New Chunk Handlers**:
1. **reasoning-delta**: Appends reasoning text, updates `streamingReasoning`
2. **tool-call**: Creates/updates tool call with "calling" status
3. **tool-result**: Updates tool call with success/error status and result

**Behavior**:
- Creates assistant message on first chunk (any type)
- Accumulates content in appropriate refs
- Updates message state via Zustand store
- Finalizes on "done" chunk

## Message Display

### `ui/components/Chat/MessageItem.tsx`
Updated to render new card types:

**Rendering Order** (for assistant messages):
1. **ThinkingCard** - if reasoning content exists
2. **ActioningCards** - if tool calls exist (rendered as list)
3. **Message text** - main content

**Streaming Logic**:
- Shows streaming cursor on reasoning if `streamingReasoning` present
- Shows streaming cursor on text if streaming but no active reasoning
- Handles both streaming and final states

## Styling Highlights

### ThinkingCard.css
- Liquid glass effect with zinc colors
- Smooth transitions (0.2s ease)
- Chevron rotation animation (-90deg when collapsed)
- Border-left accent for content
- fadeIn animation for expand

### ActioningCard.css
- Status-based dynamic styling via inline styles
- Spinner animation (1s linear infinite)
- slideIn animation (from left)
- Pulse animation on calling state (2s cubic-bezier)
- Responsive layout with flex

## Testing

To test the new cards:

1. **Test Thinking Card**:
   - Send a complex question requiring reasoning
   - Verify thinking card appears with streaming cursor
   - Verify collapse/expand works
   - Check color scheme matches zinc theme

2. **Test Actioning Card**:
   - Trigger tool calls (requires agent with tools enabled)
   - Verify "calling" state shows spinner + blue colors
   - Verify "success" state shows result + gray colors
   - Verify "error" state shows error + red colors
   - Check tool emoji matches tool type

3. **Test Integration**:
   - Send message and verify all parts render in correct order
   - Verify streaming updates work smoothly
   - Check hover states and transitions
   - Verify mobile responsiveness

## Known Limitations

1. **Tool Results**: Currently requires backend to emit `tool-result` chunks (not yet implemented in MastraAgent)
2. **Markdown**: Thinking/tool content is plain text (no markdown rendering yet)
3. **Collapse State**: Thinking card collapse state doesn't persist across refreshes
4. **Tool Call Grouping**: Each tool call renders separately (v1 has grouped tool calls in some cases)

## Next Steps

1. Update `MastraAgent.ts` to emit `tool-result` chunks when tools complete
2. Add markdown rendering for thinking/tool content
3. Implement tool call grouping for better UX with multiple tools
4. Add persistence for thinking card collapse state
5. Test with real tool calls (search, memory, etc.)
