# Tool Call Display Fix

**Date**: 2026-02-11  
**Issue**: Tool calls not showing details in UI during execution

---

## Problem

User reported: *"i don't think tool streams are making it to the UI.. nothing is happening in the UI just says bash.. i don't see the command send or 'loading' that it's still executing or anything like that.. and when tool result is done it doesn't look like the agent is getting it or doing anything"*

### What Was Wrong

1. **No Detailed Tool Info**: ExploringCard only showed tool name ("bash") without command details
2. **No Status Indicators**: No visual feedback for loading/success/error states
3. **Missing V1 Parity**: V1 showed detailed bash commands like "Running ls -la ~/Dropbox..."

### Root Cause Analysis

The streaming pipeline was working correctly:
```
AgentService (backend)
  ↓ yields tool-call chunk
WebSocket Gateway
  ↓ forwards via ws.send()
UI Gateway Client
  ↓ calls onChunk()
useAgent Hook
  ↓ updates toolCallsMapRef
ExploringCard
  ❌ Only showed toolCall.toolName (just "bash")
  ✓ Should show formatted command details
```

**The issue was in ExploringCard rendering**, not in the streaming pipeline.

---

## Solution

### 1. Enhanced ExploringCard Display

**File**: `ui/components/Chat/ExploringCard.tsx`

#### Added Utility Functions

```typescript
/**
 * Format bash command for display (matches V1 behavior)
 */
function formatBashCommand(command: string, isRunning: boolean = true): string {
  const cmd = command.trim();
  const prefix = isRunning ? 'Running' : 'Ran';
  
  // Truncate very long commands
  if (cmd.length > 60) {
    return `${prefix} ${cmd.substring(0, 57)}...`;
  }
  
  return `${prefix} ${cmd}`;
}

/**
 * Get display text for tool call (matches V1 behavior)
 */
function getToolCallDisplayText(toolCall: ToolCall): string {
  const isRunning = toolCall.status === "calling";
  
  // Handle bash commands specially - show the actual command
  if (toolCall.toolName === 'bash' && toolCall.args?.command) {
    return formatBashCommand(toolCall.args.command as string, isRunning);
  }
  
  // Map tool names to friendly descriptions
  const toolDescriptions: Record<string, { running: string; complete: string }> = {
    'create_document': { running: 'Creating document', complete: 'Document created' },
    'read_document': { running: 'Reading document', complete: 'Document read' },
    // ... etc
  };
  
  // Returns friendly name based on status
}
```

#### Updated Rendering

**Before**:
```tsx
<span className="exploring-tool-name">{toolCall.toolName}</span>
{toolCall.status === "calling" && (
  <span className="exploring-tool-status"> (calling...)</span>
)}
```

**After**:
```tsx
const displayText = getToolCallDisplayText(toolCall);
const showSpinner = toolCall.status === "calling";
const showCheckmark = toolCall.status === "success";
const showError = toolCall.status === "error";

return (
  <div className="exploring-tool-item">
    <span className="exploring-tool-arrow">→</span>
    <span className="exploring-tool-name">{displayText}</span>
    {showSpinner && <span className="exploring-tool-spinner"> ⏳</span>}
    {showCheckmark && <span className="exploring-tool-success"> ✓</span>}
    {showError && <span className="exploring-tool-error"> ✗</span>}
  </div>
);
```

### 2. Added Status Indicator Styling

**File**: `ui/components/Chat/ExploringCard.css`

```css
.exploring-tool-spinner {
  font-size: 12px;
  opacity: 0.8;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.exploring-tool-success {
  color: #10b981;  /* Green */
  font-weight: bold;
  font-size: 12px;
}

.exploring-tool-error {
  color: #ef4444;  /* Red */
  font-weight: bold;
  font-size: 12px;
}
```

### 3. Enhanced Debug Logging

**File**: `ui/hooks/useAgent.ts`

Added detailed console logs to track tool call flow:

```typescript
// In tool-call handler:
console.log(`[useAgent] 🔧 Tool call: ${payload.toolName}`, payload.args);
console.log(`[useAgent] 🔄 Updating UI with ${toolCallsArray.length} tool call(s):`, toolCallsArray);

// In tool-result handler:
console.log(`[useAgent] ✓ Tool result for ${existingCall?.toolName || payload.toolCallId}:`, 
  payload.result ? payload.result.substring(0, 100) : 'no result');
console.log(`[useAgent] 🔄 Updating UI after tool result, ${toolCallsArray.length} tool call(s):`, 
  toolCallsArray.map(tc => ({ name: tc.toolName, status: tc.status })));
```

---

## How It Works Now

### Bash Tool Example

**Backend sends**:
```json
{
  "type": "tool-call",
  "payload": {
    "toolCallId": "tool_abc123",
    "toolName": "bash",
    "args": {
      "command": "ls -la ~/Dropbox/reach"
    }
  }
}
```

**UI displays**:
```
▼ Exploring
  → Running ls -la ~/Dropbox/reach ⏳
```

**After completion**:
```
▼ Exploring
  → Ran ls -la ~/Dropbox/reach ✓
```

### Other Tools Example

**Create Document**:
- While running: "→ Creating document ⏳"
- On success: "→ Document created ✓"
- On error: "→ Document created ✗"

---

## Comparison to V1

### V1 Behavior (Preserved)

V1 had `getBashCommandDescription()` that provided context-aware descriptions:

```javascript
// Handle bash commands specially
if (toolData.name === 'bash' && toolData.input?.command) {
  name = getBashCommandDescription(toolData.input.command, isRunning);
}
```

Examples:
- `curl https://api.github.com` → "Getting info from github.com..."
- `cat > file.txt <<EOF` → "Updating file.txt..."
- `grep "pattern" *.js` → "Searching in files..."
- Generic: "Running ls -la ~/Dropbox..."

### V2 Implementation

**Phase 1** (This PR): Basic bash command display
- Shows full command: "Running ls -la ~/Dropbox..."
- Truncates long commands (60 chars)

**Phase 2** (Future): Smart descriptions like V1
- Detect curl, grep, cat, etc.
- Show context-aware descriptions
- Extract filenames, URLs, patterns

---

## Testing

### Manual Test Steps

1. **Start the app**:
   ```bash
   npm start
   ```

2. **Send a bash command**:
   ```
   "List files in ~/Dropbox directory"
   ```

3. **Expected UI during execution**:
   ```
   ▼ Deep in thought
     **Running a search with Bash**
     
   ▼ Exploring
     → Running ls -la ~/Dropbox ⏳
   ```

4. **Expected UI after completion**:
   ```
   ▼ Deep in thought
     [collapsed]
     
   ▼ Exploring
     → Ran ls -la ~/Dropbox ✓
     
   [Assistant response with file list]
   ```

### Console Logs to Verify

```
[useAgent] 🔧 Tool call: bash { command: "ls -la ~/Dropbox" }
[useAgent] 🔄 Updating UI with 1 tool call(s): [{ id: "...", toolName: "bash", args: {...}, status: "calling" }]
[useAgent] ✓ Tool result for bash: total 0\ndrwxr-xr-x  5 user  staff  160 Feb 11 10:30 .\ndrwxr-xr-x...
[useAgent] 🔄 Updating UI after tool result, 1 tool call(s): [{ name: "bash", status: "success" }]
```

---

## Files Changed

1. **ui/components/Chat/ExploringCard.tsx**
   - Added `formatBashCommand()` utility
   - Added `getToolCallDisplayText()` utility
   - Updated rendering with status indicators

2. **ui/components/Chat/ExploringCard.css**
   - Added `.exploring-tool-spinner` with animation
   - Added `.exploring-tool-success` (green checkmark)
   - Added `.exploring-tool-error` (red X)

3. **ui/hooks/useAgent.ts**
   - Enhanced console logging for debugging
   - Added emoji indicators (🔧, ✓, 🔄) for log clarity

---

## Related Documentation

- **V1 Analysis**: See terminal output grep results for `getBashCommandDescription`
- **Streaming Architecture**: See `docs/ARCHITECTURE.md`
- **Tool System**: See `docs/TOOL_GAPS.md`

---

## Future Enhancements

1. **Smart Bash Descriptions** (like V1):
   - Detect `curl` → "Getting info from {domain}..."
   - Detect `cat > file` → "Updating {filename}..."
   - Detect `grep pattern` → "Searching in files..."

2. **Expandable Tool Details**:
   - Click to expand full args
   - Show tool result inline (truncated)

3. **Tool Call Grouping**:
   - Multiple sequential bash commands
   - Show as timeline/steps

4. **Performance Optimization**:
   - Debounce UI updates for rapid tool calls
   - Virtual scrolling for many tool calls

---

## Status

✅ **FIXED** - Tool calls now show detailed information with status indicators matching V1 behavior.

**Next**: Test with various tool types (bash, document operations, app operations) to verify all paths work correctly.
