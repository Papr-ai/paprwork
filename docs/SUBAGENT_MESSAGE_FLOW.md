# Sub-Agent Message Flow & Filtering Rules

**Date:** 2026-02-22

## Complete Message Flow

### Flow 1: Sub-Agent Answers Directly (No User Interaction)

```
1. User delegates task → Main Agent
2. Main Agent → create_sub_agent → Sub-Agent starts
3. Sub-Agent does work (thinking, tools, etc.)
4. Sub-Agent → deliver_output → Job completes
5. Delegation Card shows final result in main chat
```

**Where messages appear:**
- ✅ Main Chat: Delegation card with final result
- ✅ Mini-Chat: Full sub-agent conversation (thinking, tools, output)

---

### Flow 2: Sub-Agent Asks Question → Main Agent Answers Directly

```
1. Sub-Agent encounters issue
2. Sub-Agent → request_agent_input(question) 
3. SubAgentResponseTrigger injects synthetic message to MAIN CHAT:
   "[Sub-agent question for delegation abc-123]
   
   {sub-agent's question}
   
   Your job: Answer using respond_to_sub_agent..."

4. Main Agent sees synthetic message in chat history
5. Main Agent → respond_to_sub_agent(delegationId, answer)
6. Sub-Agent receives answer, continues work
```

**Where messages appear:**
- ❌ Main Chat: NOTHING (filtered out)
  - Synthetic user message: Hidden by MessageList filter
  - Assistant response with respond_to_sub_agent: Hidden by MessageList filter
- ✅ Mini-Chat: Full exchange visible
  - "Sub-agent asked: {question}"
  - "Main agent answered: {response}"

**Filtering Logic:**
```typescript
// MessageList.tsx filters BOTH:
1. User messages starting with "[Sub-agent question for delegation"
2. Assistant messages with respond_to_sub_agent tool calls
```

---

### Flow 3: Sub-Agent Asks Question → Main Agent Needs User Help

```
1. Sub-Agent encounters issue
2. Sub-Agent → request_agent_input(question)
3. SubAgentResponseTrigger injects synthetic message to MAIN CHAT:
   "[Sub-agent question for delegation abc-123]
   
   {sub-agent's question}
   
   Your job: Answer using respond_to_sub_agent...
   
   If you need user help: Respond in MAIN CHAT without 
   using respond_to_sub_agent. Do NOT use respond_to_sub_agent 
   when asking the user - that's only for answering the sub-agent."

4. Main Agent sees synthetic message
5. Main Agent cannot answer → Responds to USER (no tool call)
   "Hey, the sub-agent needs help with X. Can you provide Y?"
6. User sees message in main chat
7. User responds in main chat
8. Main Agent → respond_to_sub_agent(delegationId, user's answer)
9. Sub-Agent receives answer, continues work
```

**Where messages appear:**
- ✅ Main Chat: Question to user (no respond_to_sub_agent tool)
  - Synthetic user message: Hidden by filter
  - Main agent asking user: VISIBLE (no respond_to_sub_agent)
  - User's response: VISIBLE
  - Main agent forwarding to sub-agent: HIDDEN (has respond_to_sub_agent)
- ✅ Mini-Chat: Full exchange
  - "Sub-agent asked: {question}"
  - "Main agent answered: {user's response}"

**Key Point:** Main agent can send TWO responses:
1. To user (main chat): Regular message, no tool call → VISIBLE
2. To sub-agent (after user answers): respond_to_sub_agent → HIDDEN

---

### Flow 4: User Joins Mini-Chat and Sends Message

```
1. User clicks mini-chat card
2. User sends message in mini-chat
3. Mini-chat → gateway → subagent:send-message
4. SubAgentResponseTrigger injects synthetic message to MAIN CHAT:
   "[User message in sub-agent chat for delegation abc-123]
   
   The user joined the mini-chat and sent: '{message}'
   
   Your job: Respond to the user. Use respond_to_sub_agent 
   with delegationId and your response."

5. Main Agent → respond_to_sub_agent(delegationId, response)
6. Response appears in mini-chat
```

**Where messages appear:**
- ❌ Main Chat: NOTHING (filtered out)
  - Synthetic user message: Hidden by filter
  - Assistant response: Hidden (has respond_to_sub_agent)
- ✅ Mini-Chat: Full conversation
  - User's message
  - Main agent's response

---

## Filtering Rules Summary

### MessageList.tsx (Main Chat)

**Hides:**
1. ❌ User messages starting with:
   - `[Sub-agent question for delegation`
   - `[User message in sub-agent chat for delegation`

2. ❌ Assistant messages containing:
   - `respond_to_sub_agent` tool calls

**Shows:**
✅ Real user messages  
✅ Assistant responses WITHOUT respond_to_sub_agent  
✅ Delegation cards  
✅ All other tool calls

### MiniChatCard (Mini-Chat)

**Shows everything:**
✅ Sub-agent questions  
✅ Main agent responses  
✅ User messages  
✅ Full conversation thread

---

## Critical Design Decisions

### 1. Why Synthetic Messages Go to Main Chat

The synthetic messages are injected into the MAIN CHAT (user's chatId), not the delegation chat, because:
- Main agent needs full context from user's conversation
- Main agent should answer using same session/memory as user chat
- Allows main agent to ask user for help seamlessly

### 2. Why We Filter at Display Time

Filtering happens in `MessageList.tsx` (display) rather than storage because:
- Messages need to be in storage for main agent to see them
- Main agent needs to process synthetic messages
- Mini-chat needs to show full conversation
- Filtering at display is cleanest separation

### 3. Why respond_to_sub_agent Indicates Hidden Message

Any message with `respond_to_sub_agent` is internal sub-agent communication:
- User doesn't need to see "Main agent told sub-agent X"
- Result shows in delegation card or mini-chat
- Keeps main chat focused on user ↔ main agent

---

## Edge Cases

### What if Main Agent Uses respond_to_sub_agent AND Regular Response?

**Scenario:** Main agent both answers sub-agent and talks to user in same message.

**Current Behavior:** Entire message is hidden (has respond_to_sub_agent).

**Better Behavior:** Split into two responses:
1. First response: To user (no tool) → VISIBLE
2. Second response: respond_to_sub_agent(user's answer) → HIDDEN

**Prompt instructs:** "Do NOT use respond_to_sub_agent when asking the user"

### What if User Responds to Filtered Message?

**Scenario:** Main agent's response to sub-agent is hidden, but context appears in next user message.

**Current Behavior:** Works fine - user's message is visible, no confusion.

**Why:** Filtered messages are responses to sub-agent, not to user.

---

## Testing Checklist

### Flow 2: Main Agent Answers Sub-Agent
- [ ] Synthetic user message hidden from main chat
- [ ] Main agent response with respond_to_sub_agent hidden from main chat
- [ ] Both messages visible in mini-chat
- [ ] Delegation card updates with progress

### Flow 3: Main Agent Asks User
- [ ] Synthetic user message hidden from main chat
- [ ] Main agent's question to user VISIBLE in main chat
- [ ] User's response VISIBLE in main chat
- [ ] Main agent forwarding answer (respond_to_sub_agent) HIDDEN from main chat
- [ ] Full exchange visible in mini-chat

### Flow 4: User Messages in Mini-Chat
- [ ] User's message in mini-chat visible in mini-chat
- [ ] Main agent response visible in mini-chat
- [ ] Synthetic message hidden from main chat
- [ ] Main agent response hidden from main chat

---

## Related Files

- `ui/components/Chat/MessageList.tsx` - Main chat filtering
- `ui/components/Chat/MiniChatCard.tsx` - Mini-chat display (unfiltered)
- `src/gateway/services/SubAgentResponseTrigger.ts` - Synthetic message injection
- `ui/hooks/useAgent.ts` - Stream chunk filtering
- `ui/utils/historyMapper.ts` - History hydration filtering
- `docs/SUBAGENT_MESSAGE_FILTERING.md` - Implementation details
