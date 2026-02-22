# Mini-Chat Card Flow

## Current Behavior

### Sub-agent question → UI
When a sub-agent calls `request_agent_input`:
1. Question broadcasts to UI via `subagent-chat:question`
2. MiniChatCard displays it in the message thread (with sub-agent avatar)
3. User can click **Join** and respond inline

### Main agent auto-response ✅
**Implemented.** When a sub-agent asks a question (with `delegationId`), the main agent is automatically triggered to respond:
1. `SubAgentResponseTrigger` gets `reportChatId` from the job
2. Runs `streamAgent` with a synthetic message instructing it to use `respond_to_sub_agent`
3. Broadcasts chunks to the UI (useAgent listens for `gateway-broadcast` agent:chunk)
4. Main agent's response appears in the main chat and is broadcast to the MiniChatCard via `respondToSubAgent`

**Flow:**
- Sub-agent question → MiniChatCard + broadcast
- Backend triggers main agent with synthetic prompt
- Main agent responds via `respond_to_sub_agent` tool
- Response broadcasts to MiniChatCard (`subagent-chat:message`)
- User can also Join and respond manually
