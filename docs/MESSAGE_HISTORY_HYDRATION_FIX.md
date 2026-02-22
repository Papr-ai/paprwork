# Message History Hydration Fix

## Issues Reported

1. **"Things from other chats"** – After closing and reopening the app, messages appear that seem to belong to a different conversation.
2. **"Things I didn't see in stream"** – Messages appear in history that were not visible during the live stream (e.g. `[Sub-agent question for delegation X]`).
3. **Synthetic messages in main chat** – Sub-agent question/response exchange should only appear in MiniChatCard, not in the regular chat.

## Root Causes & Fixes

### 1. Synthetic Sub-Agent Exchange – Hide from Main Chat ✅ FIXED

**Cause:** When a sub-agent asks a question, the backend injects a synthetic user message and runs the main agent. Both the synthetic message and the main agent's response were shown in the main chat, but they're already displayed in the MiniChatCard—showing them in both places is confusing.

**Fix:**
- **During stream:** Ignore `agent:chunk` and `agent:complete` when `isSubAgentTrigger: true`—don't add to main chat
- **In history:** Filter out synthetic user messages and their immediately following assistant response in `mapHistoryMessages`

**Files changed:**
- `ui/hooks/useAgent.ts` – Skip chunks with `isSubAgentTrigger` (no main-chat display)
- `ui/utils/historyMapper.ts` – Filter synthetic sub-agent exchange from loaded history

### 2. "Other Chats" – Likely Same Chat, Multiple Delegations

**Explanation:** The "iftar restaurant ranking" content and the "weekend-adventure calibration" content can both belong to the **same chat**. Each delegation creates:

- A synthetic user message (sub-agent question)
- An assistant message (main agent response)
- Optionally, a job output message (from `AgentJobExecutor` when the job completes)

If you ran multiple delegations in one chat (e.g. iftar task first, then strategic question task), all of those messages are stored in that chat. On reload, you see the full history in chronological order.

**Verification:** Check whether the chat you’re viewing is the same one where you ran both tasks. If so, this is expected behavior.

### 3. Cross-Chat Contamination (Unlikely)

**Current behavior:**
- `loadMessages(chatId)` filters by `WHERE chat_id = ?`
- `ChatContainer` receives `chatId` from the tab’s `entityId`
- Hydration always fetches for the active tab’s chat

If you still see messages from a different chat, possible causes:
- Tab/chat mapping bug (wrong `entityId` for a tab)
- PAPR/Hybrid storage returning the wrong session

## Data Flow Summary

```
User sends message → UI adds to chatStore → Backend saves
Sub-agent question → Backend saves synthetic user message → (FIX) Backend broadcasts agent:user-message → UI adds to chatStore
Stream chunks → Backend broadcasts agent:chunk → UI updates assistant message
Stream complete → Backend saves assistant message → Backend broadcasts agent:complete
App reopen → ChatContainer hydrates → fetchChatHistory(chatId) → loadMessages(chatId) → UI replaces chatStore
```

## Testing

1. **Synthetic message during stream:** Delegate a task that triggers a sub-agent question. Confirm the `[Sub-agent question for delegation X]` message appears in the chat while the agent is responding, not only after reload.
2. **History on reopen:** Close and reopen the app. Confirm the same messages appear in the same order, with no cross-chat mixing.
