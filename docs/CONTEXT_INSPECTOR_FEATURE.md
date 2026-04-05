# Context Inspector Feature

**Added:** 2026-03-04

## Overview

The Context Inspector is a powerful debugging and transparency feature that lets users see exactly what context is being sent to the LLM on each turn. This helps users:

1. **Understand token usage** - See which parts of the context consume the most tokens
2. **Debug context issues** - Identify missing or incorrect context
3. **Optimize prompts** - Find opportunities to reduce token usage
4. **Trust the AI** - Full transparency into what the AI "sees"

## How to Use

1. Open any chat conversation
2. Type `/context` in the message input
3. Press Enter or select from the slash command menu
4. A modal will appear showing the complete context breakdown

## What You Can See

### 1. System Prompt
- **Tokens:** ~15,000-30,000 tokens
- **Content:** The complete system prompt including:
  - Identity and capabilities
  - Tool descriptions
  - **Workspace context (MEMORY.md, IDENTITY.md, etc.) - embedded here**
  - Active skills
  - Active plans
  - Behavior guidelines
- **Note:** Workspace files are part of the system prompt, not sent separately

### 2. Conversation Summary (if present)
- **Tokens:** Varies (usually 1,000-5,000 tokens)
- **Content:** Auto-generated summary of archived messages
- **When present:** After conversations exceed 50,000 tokens and get compressed
- **How sent:** As a **user message** (not in system prompt) before recent history

### 3. Message History
- **Tokens:** Varies (depends on conversation length)
- **Content:** Recent messages in the conversation
- **Note:** Tool results are truncated to 400 chars in history to save tokens

### 4. Available Tools
- **Tokens:** ~8,000-12,000 tokens (70+ tools)
- **Content:** Complete tool schemas with:
  - Tool IDs
  - Descriptions
  - Parameter schemas (expandable)

### 5. Workspace Files (Reference Only)
- **Tokens:** 0 (already counted in system prompt)
- **Content:** Markdown files from `~/Papr/workspace/`:
  - `MEMORY.md` - Long-term curated memory
  - `IDENTITY.md` - User profile
  - `AGENTS.md` - Operating contract
  - `TOOLS.md` - Environment notes
  - Daily logs (today + yesterday)
- **Note:** These are shown for visibility but are embedded in the system prompt above

### 6. Active Skills (Reference Only)
- **Tokens:** Already counted in system prompt
- **Content:** Enabled skills with descriptions
- **Examples:** Code reviewer, writing assistant, research specialist
- **Note:** Skill references are part of the system prompt

### 7. Active Plans (Reference Only)
- **Tokens:** Already counted in system prompt
- **Content:** Unfinished plans for this chat with:
  - Plan title
  - Step-by-step checklist
  - Progress indicators (✓ completed, ▶ in progress, ○ pending)
- **Note:** Plan references are part of the system prompt

## Technical Architecture

### Backend (Gateway)

**New method:** `AgentService.inspectContext(chatId, selectedModel)`

This method:
1. Loads history from storage (same as actual agent run)
2. Builds system prompt with all dynamic context (workspace files embedded here)
3. Formats messages for the model (exact same format sent to LLM)
4. **Conversation summary** is added as a user message (not in system prompt)
5. Counts tokens for each section (1 token ≈ 4 chars)
6. Returns structured breakdown

**Important token counting:**
- System prompt includes workspace files, skills, plans (all embedded)
- Conversation summary is a separate user message
- Workspace files shown in UI are for reference only (tokens already counted in system prompt)
- Skills and plans shown in UI are for reference only (tokens already counted in system prompt)

**New WebSocket handler:** `chat:inspect-context`

Route: `gateway → chat.ts → AgentService.inspectContext()`

### Frontend (UI)

**Component:** `ContextInspectorModal.tsx`

Features:
- Expandable sections (click to view content)
- Token counts for each section with percentages
- Syntax highlighting for tool schemas
- Scrollable content areas
- Beautiful modal overlay

**Integration:** `ChatContainer.tsx`

- Triggers on `/context` slash command
- Sends `chat:inspect-context` message to gateway
- Opens modal with returned data
- Closes on click outside or X button

## Token Estimation

The inspector uses a rough estimation: **1 token ≈ 4 characters**

This is approximate because:
- Different models use different tokenizers
- Some tokens represent more/fewer characters
- Special characters may tokenize differently

For precise token counts, use the model's native tokenizer. Our estimation is within 10-20% accuracy for most text.

## Performance

**Impact:** Minimal
- Uses same context-building logic as actual agent runs
- No additional database queries (uses existing history load)
- Modal rendering is lazy (only when opened)
- Context is computed on-demand (not cached)

**Response time:** Usually <500ms for typical conversations

## Use Cases

### Debugging Context Issues

**Problem:** Agent doesn't remember something you told it earlier

**Solution:**
1. Open Context Inspector (`/context`)
2. Check **Message History** section - verify the message exists
3. If missing, check **Conversation Summary** - may be archived
4. If in summary, the agent still has access via compressed context

### Optimizing Token Usage

**Problem:** Hitting context limits too quickly

**Solution:**
1. Open Context Inspector
2. Look at token percentages for each section
3. Identify the largest sections
4. Consider:
   - Disabling unused skills
   - Completing/canceling old plans
   - Archiving workspace files that aren't needed
   - Using shorter messages

### Understanding System Behavior

**Problem:** Want to know what instructions the agent has

**Solution:**
1. Open Context Inspector
2. Expand **System Prompt** section
3. Read the complete instructions
4. See all available tools and their descriptions

## Future Enhancements

Potential improvements:
- [ ] Export context as JSON/Markdown
- [ ] Compare context between turns (diff view)
- [ ] Real-time token counting as you type
- [ ] Per-message token counts in chat history
- [ ] Context pressure warnings (approaching limits)
- [ ] Recommendations for reducing token usage
- [ ] Native tokenizer integration (precise counts)

## Files Changed

### Gateway
- `src/gateway/services/AgentService.ts` - Added `inspectContext()` method
- `src/gateway/websocket/chat.ts` - Added `chat:inspect-context` handler

### UI
- `ui/components/Chat/ContextInspectorModal.tsx` - New modal component
- `ui/components/Chat/ContextInspectorModal.css` - Modal styles
- `ui/components/Chat/ChatContainer.tsx` - Integrated modal trigger
- `ui/components/Chat/SlashCommandMenu.tsx` - Already had `/context` command

## Related Documentation

- `docs/TOOL_RESULT_TRUNCATION_FIX.md` - Why tool results are truncated in history
- `docs/SUMMARY_AS_SYSTEM_CONTEXT_FIX.md` - How conversation compression works
- `docs/CONTEXT_MANAGEMENT_BEST_PRACTICES.md` - General context management
- `CLAUDE.md` - System prompt structure and composition
