# Mini-Chat Card Flow

## Storage Model (Same as Regular Chat)

Sub-agent ↔ main-agent conversation is stored like regular chat:

- **Chat ID:** `delegation:{delegationId}` (delegationId = job ID)
- **Storage:** Same StorageManager (chat DB + Papr memory messages endpoint)
- **Messages:** StoredMessage format with `source_agent_id` / `source_agent_name` for attribution

When the first message is saved, the chat is created automatically (LocalStorageProvider ensures chat exists; Papr creates on first message).

## Full Flow (Question → Response → Resume)

### 1. Sub-agent asks question
When a sub-agent calls `request_agent_input` with `delegationId`:

1. **Save** question to delegation chat (`delegation:{delegationId}`)
2. **Broadcast** `subagent-chat:question` to UI (MiniChatCard)
3. **Trigger** main agent via `SubAgentResponseTrigger`
4. **Block** until main agent/user responds (or 5 min timeout)

### 2. Main agent or user responds
When main agent calls `respond_to_sub_agent` or user sends via MiniChatCard:

1. **Save** response to delegation chat
2. **Broadcast** `subagent-chat:message` to UI
3. **Unblock** waiting sub-agent (resolve pending promise)

### 3. Sub-agent continues
The `request_agent_input` tool returns with the response:

```
{ success: true, data: { message: "Main agent responded: ...", response: "...", status: "resumed" } }
```

Sub-agent receives this as tool result and continues with the new context.

## UI Flow

- Sub-agent question → MiniChatCard displays it (sub-agent avatar)
- Main agent auto-responds (triggered by SubAgentResponseTrigger)
- Main agent response → MiniChatCard (main-agent avatar)
- User can **Join** and respond manually → `subagent:send-message` → `respondToSubAgent` with `author: "user"`
