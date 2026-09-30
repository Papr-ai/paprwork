# Per-Chat Model Scoping

**Fixed:** 2026-09-03

## Symptom

Open three chats — two on Claude Opus 5, one on Claude Fable 5.1. Return to an
Opus chat and the picker reads **Fable 5.1**, in a chat where Fable was never
used.

This is not only a mislabelled picker. The picker's value is what
`ChatContainer` sends as `config.model`, so the displayed model is the model
that answers.

## Evidence

From a real installation (`chats.db`, read-only):

```sql
SELECT model, COUNT(*) FROM messages
WHERE chat_id = 'e7008114-…' AND role = 'assistant'
GROUP BY model ORDER BY MIN(timestamp);

claude-opus-5  | 32   -- 2026-09-02T16:08 … 2026-09-03T23:30
claude-fable-5 |  2   -- 2026-09-02T23:41 … 2026-09-03T01:04
```

Two turns of an Opus conversation were served by Fable, *interleaved* with the
Opus turns rather than appended — so this was not the user switching models
partway through. Across 30 days, 16 of 288 chats had more than one model answer,
including cross-provider pairs such as `claude-opus-5` + `gpt-5-6-sol-high`.

## Root cause

Model selection had three layers, and only the weakest one was durable:

| Layer | Scope | Survived restart? |
|---|---|---|
| `ChatContainer` `useState` | one mounted chat | no |
| `chatStates[chatId].lastSelectedModelId` | per chat | **no** (plain Zustand map) |
| `localStorage["paprwork_last_model_id"]` | **global** | yes |

`getLastSelectedModel(chatId)` fell through to the global value whenever the
requested chat had no in-memory entry:

```ts
const fromChat = state.chatStates.get(chatId)?.lastSelectedModelId;
if (fromChat) return fromChat;
return localStorage.getItem("paprwork_last_model_id"); // ← another chat's model
```

Three ordinary events empty the per-chat map, after which *every* chat reads the
global:

1. **App restart** — the store has no `persist` middleware.
2. **Workspace switch** — `resetForWorkspaceSwitch()` clears `chatStates`.
3. **A chat that never touched the picker** — `defaultChatState` omits
   `lastSelectedModelId`, so it is only ever written by an explicit change.

Chat tabs also unmount when you switch away (unlike app tabs, they are not
kept alive), so returning to a chat re-runs hydration and re-reads the global.

## The fix

Separate the two questions that were conflated:

- **Which model is *this chat* on?** Persisted per chat, keyed by `chatId`
  (`ui/utils/chatModelMemory.ts`), so it survives restarts and workspace
  switches. Bounded at `MAX_REMEMBERED_CHATS` (200), evicting least-recently-used.
- **Which model should a *new chat* start on?** The global last pick. Still
  global, because here that is the correct answer.

Precedence is now (`ui/utils/resolveChatModel.ts`):

1. This chat's explicit selection.
2. The model that last answered **in this chat**, read from `messages.model` in
   its own history. This is server-side truth and needs no new schema — it works
   even after local storage is cleared or the app is reinstalled.
3. The global default — **only** when the chat has no history. An existing chat
   never inherits another chat's model.
4. The app's ordinary defaults (`sonnet-5` → `gpt-5-6-sol` → …).

`hasHistory` comes from chat metadata (`messageCount`), so it is known before
history finishes loading. A reopened chat therefore never flashes another chat's
model while waiting.

Re-deriving is idempotent: an explicit per-chat pick outranks history, so the
hydration effect can re-run when history arrives without walking back a
selection the user just made.

## Files

| File | Change |
|---|---|
| `ui/utils/chatModelMemory.ts` | **New** — durable per-chat store, bounded, with rename/forget |
| `ui/utils/resolveChatModel.ts` | **New** — precedence rule and history lookup, pure |
| `ui/stores/chatStore.ts` | Global fallback removed from `getLastSelectedModel`; added `getDefaultModelForNewChat`; selection carried across the temp→permanent id rename |
| `ui/components/Chat/ChatContainer.tsx` | Hydration uses the precedence rule |
| `ui/utils/historyMapper.ts`, `ui/types/chat.ts` | Carry `model` per message so a chat can recover its own model |
| `ui/hooks/useChat.ts` | Forget a deleted chat's model |
| `ui/App.tsx` | Boot seeds the *new-chat* default, not per-chat state |
| `tests/chat-model-scoping.test.ts` | 21 tests |

## Tests

```bash
npx vitest run tests/chat-model-scoping.test.ts --config vitest.config.unit.ts
```

Covers per-chat isolation, survival across a simulated restart, the reported
regression (existing chat + global Fable → does *not* return Fable), new-chat
seeding, the temp→permanent rename, LRU eviction, corrupted/tampered storage,
and a missing `window`.

## Prevention

"Which model is this chat on" and "which model should a new chat use" are
different questions with different scopes. A read for a specific key must not
fall back to a global value — returning *something* looks robust but silently
answers a question that was not asked. If per-entity state is worth reading
after a restart, it has to be persisted per entity; an in-memory map plus a
global fallback degrades into the global on every restart.
