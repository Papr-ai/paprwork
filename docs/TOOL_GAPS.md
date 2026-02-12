# Tool Implementation Gaps: V1 vs V2

**Analysis Date:** 2026-02-12

## Summary

**V1 has 40+ tools** across multiple categories  
**V2 has 5 tools** (bash + 4 filesystem)  
**Gap:** 35+ tools to implement

---

## Tool Inventory Comparison

| Category | V1 Tools | V2 Tools | Status |
|----------|----------|----------|--------|
| **Bash** | 1 | 1 | ✅ Complete |
| **Filesystem** | ~4 | 4 | ✅ Complete |
| **Apps** | 8 | 0 | ❌ Missing |
| **Documents** | 4 | 0 | ❌ Missing |
| **Skills** | 2 | 0 | ❌ Missing |
| **Browser** | 6 | 0 | ❌ Missing |
| **Webview** | 11 | 0 | ❌ Missing |
| **Jobs** | 1 | 0 | ❌ Missing |
| **Papr Memory** | 3 | 0 | ❌ Missing |
| **Sub-agents** | 2 | 0 | ❌ Missing |
| **Planning** | 2 | 0 | ❌ Missing |
| **Logging** | 1 | 0 | ❌ Missing |
| **API Keys** | 3 | 0 | ❌ Missing |
| **OAuth (Google)** | 5 | 0 | ❌ Missing |
| **OAuth (Notion)** | 4 | 0 | ❌ Missing |

---

## Critical Gaps to Address

### 1. Schema Format Differences

**V1 Format (Claude-native):**
```javascript
{
  name: 'bash',
  description: 'Execute bash commands',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '...' }
    },
    required: ['command']
  }
}
```

**V2 Format (Mastra):**
```typescript
createTool({
  id: 'bash',
  description: 'Execute bash commands',
  inputSchema: z.object({
    command: z.string().describe('...')
  }),
  execute: async (input) => { ... }
})
```

**Difference:**
- V1: JSON Schema directly
- V2: Zod schema (Mastra converts to JSON Schema internally)

✅ **This is fine** - Mastra handles conversion

---

### 2. Missing Tool Features from V1

#### a. Custom API Key Substitution in Bash
**V1:**
```javascript
// Bash command: "curl -H 'Authorization: Bearer ${OPENAI_API_KEY}'"
// Automatically substitutes custom keys before execution
substituteCustomKeys(command, customKeys);
```

**V2:** ❌ Not implemented

**Impact:** Users can't use custom keys in bash commands  
**Priority:** Medium (nice-to-have, not critical)

---

#### b. Result Truncation
**V1:**
```javascript
const MAX_TOOL_RESULT_LENGTH = 100000; // ~25K tokens
// Truncates large results before sending to model
```

**V2:** ❌ Not implemented

**Impact:** Large outputs (e.g., `npm install`) could exceed context  
**Priority:** High (prevents token overflow)

---

#### c. Document Change Detection
**V1:**
```javascript
// Snapshots active document before/after bash execution
// Prompts AI to review changes
```

**V2:** ❌ Not implemented

**Impact:** Less helpful UX for file operations  
**Priority:** Low (nice UX feature)

---

#### d. Error Sanitization
**V1:**
```javascript
sanitizeError(error) {
  // Removes API keys from error messages
  // Prevents leaking secrets in logs/UI
}
```

**V2:** ❌ Not implemented

**Impact:** Could leak API keys in error messages  
**Priority:** High (security issue)

---

#### e. Context-Based Tool Filtering
**V1:**
```javascript
// Tools can specify contexts they're available in
{
  name: 'update_document',
  contextOnly: ['prep'], // Only in meeting prep context
  // ...
}
```

**V2:** ❌ Not implemented

**Impact:** Can't restrict tools to specific contexts  
**Priority:** Low (advanced feature)

---

#### f. Sub-Agent Tool Permissions
**V1:**
```javascript
const allowedTools = {
  'browser': ['browser_navigate', 'browser_click', ...],
  'bash': ['bash'],
  'papr': ['register_schema', 'add_agent_memory', ...],
  // ...
};
// Sub-agents get filtered tool sets
```

**V2:** ❌ Not implemented (no sub-agents yet)

**Impact:** Can't implement sub-agents without this  
**Priority:** Medium (needed for sub-agents)

---

#### g. OAuth Tool System
**V1:**
```javascript
// Dynamic tools based on OAuth connections
if (googleConnected) {
  tools.push(...googleTools); // gmail_search, calendar_search_events, etc.
}
```

**V2:** ❌ Not implemented

**Impact:** No Gmail/Calendar/Notion integration  
**Priority:** Low (can add later)

---

### 3. Missing Tool Categories (Priority Order)

#### High Priority (Core Functionality)

**1. Browser Tools** (6 tools)
- `browser_navigate` - Navigate to URL
- `browser_snapshot` - Get page structure
- `browser_click` - Click elements
- `browser_type` - Type text
- `browser_scroll` - Scroll page
- `browser_tabs` - Manage tabs

**Why:** Critical for web research, testing, automation

**2. Papr Memory Tools** (3 tools)
- `register_schema` - Register data schema
- `add_agent_memory` - Add memory to PAPR
- `search_agent_memory` - Search PAPR memory

**Why:** Core Paprwork differentiator

**3. Jobs Tool** (1 tool with actions)
- `jobs` - List, status, logs, start, stop jobs

**Why:** Unique Paprwork feature, high user value

---

#### Medium Priority (Enhanced UX)

**4. Documents** (4 tools)
- `create_document` - Create new document
- `list_documents` - List all documents
- `read_document` - Read document content
- `update_document` - Update document
- `open_file` - Open in default app

**Why:** Better file management UX

**5. Apps (Mini-Apps)** (8 tools)
- `create_app` - Create new app
- `list_apps` - List all apps
- `read_app_file` - Read app source
- `edit_app_file` - Edit app code
- `launch_app` - Run the app
- `publish_app` - Share to marketplace
- `install_app` - Install from marketplace
- `list_community_apps` - Browse marketplace

**Why:** Unique feature, high differentiation

**6. Skills** (2 tools)
- `read_skill` - Read skill definition
- `create_skill` - Create new skill

**Why:** Extensibility framework

---

#### Low Priority (Nice-to-Have)

**7. Sub-Agents** (2 tools)
- `delegate_task` - Delegate to specialized agent
- `list_agents` - List available agents

**Why:** Advanced feature, not critical for MVP

**8. Planning** (2 tools)
- `create_plan` - Create task plan
- `update_plan` - Update plan progress

**Why:** Power user feature

**9. Webview** (11 tools)
- Similar to browser but for embedded webviews
- Used for mini-apps and embedded content

**Why:** Advanced UI feature

**10. OAuth Tools** (Google: 5, Notion: 4)
- Gmail, Calendar, Notion integrations

**Why:** Premium integrations, not MVP

---

## Key Architectural Differences

### 1. Tool Result Format

**V1:**
```javascript
// Simple string return (often JSON-encoded)
return JSON.stringify({ stdout, stderr, exitCode });
```

**V2:**
```typescript
// Structured ToolResult
return {
  success: true,
  data: { stdout, stderr, exitCode },
  // OR
  success: false,
  error: 'Error message',
  type: 'error_type'
};
```

✅ **V2 is better** - Type-safe, structured, easier to handle

---

### 2. Tool Execution

**V1:**
```javascript
// Manual switch statement for each tool
switch (toolName) {
  case 'bash': return await executeBash(...);
  case 'read_file': return await readFile(...);
  // ... 40+ cases
}
```

**V2:**
```typescript
// Mastra handles execution automatically
// Tools registered once, framework routes calls
tools: this.toolRegistry.getToolsForMastra()
```

✅ **V2 is better** - No manual routing, cleaner

---

### 3. Error Handling

**V1:**
```javascript
// Global try/catch with string return
try {
  result = executeTool(name, input);
} catch (error) {
  return `Error: ${error.message}`;
}
```

**V2:**
```typescript
// Structured error types
return {
  success: false,
  error: 'Error message',
  type: 'validation_error' | 'timeout_error' | 'execution_error'
};
```

✅ **V2 is better** - Type-safe error handling

---

### 4. Schema Validation

**V1:**
```javascript
// Manual validation in each tool
if (!input.command) {
  throw new Error('command is required');
}
```

**V2:**
```typescript
// Zod validates automatically
const BashInputSchema = z.object({
  command: z.string().describe('...'),
});
// Mastra validates before calling execute()
```

✅ **V2 is better** - Automatic validation, less boilerplate

---

## Missing Features Analysis

### Critical (Implement First)

**1. Result Truncation**
```typescript
// Add to core/tools/types.ts
export const MAX_TOOL_RESULT_LENGTH = 100000;

export function truncateResult(result: string): string {
  if (result.length > MAX_TOOL_RESULT_LENGTH) {
    const truncated = result.substring(0, MAX_TOOL_RESULT_LENGTH);
    return truncated + `\n\n[... truncated ${result.length - MAX_TOOL_RESULT_LENGTH} chars]`;
  }
  return result;
}
```

**2. Error Sanitization (Security!)**
```typescript
export function sanitizeError(error: string, apiKeys: string[]): string {
  let sanitized = error;
  for (const key of apiKeys) {
    if (key) {
      sanitized = sanitized.replace(new RegExp(key, 'g'), '***');
    }
  }
  return sanitized;
}
```

**3. Custom Key Substitution in Bash**
```typescript
export function substituteCustomKeys(
  command: string,
  customKeys: Record<string, string>
): string {
  let result = command;
  for (const [name, value] of Object.entries(customKeys)) {
    result = result.replace(new RegExp(`\\$\\{${name}\\}`, 'g'), value);
  }
  return result;
}
```

---

### Important (Implement Soon)

**4. Browser Tools** (Top Priority)
- Cursor IDE has browser MCP server
- Can reuse MCP browser tools
- Critical for web research/testing

**5. Papr Memory Tools**
- `register_schema` - Schema registration
- `add_agent_memory` - Store memories
- `search_agent_memory` - Retrieve context

**6. Jobs Tool**
- Single tool with `action` parameter
- List, status, logs, start, stop
- Critical for automation workflows

---

### Can Wait

**7. Apps/Documents/Skills**
- Implement after core tools are solid
- Build on top of filesystem tools

**8. Webview**
- Advanced UI feature
- Similar to browser but embedded
- Not needed for MVP

**9. OAuth Integrations**
- Premium feature
- Implement after core is stable

---

## Recommendation: Implementation Order

### Phase 1: Critical Fixes ✅ **COMPLETE** (45 minutes)
1. ✅ Added result truncation helper (`truncateResult`)
2. ✅ Added error sanitization (security!) (`sanitizeError`, `sanitizeToolOutput`)
3. ✅ Added custom key substitution for bash (`substituteCustomKeys`)
4. ⏳ Test all 5 existing tools in UI ← **NEXT STEP**

**See:** [PHASE_1_COMPLETE.md](./PHASE_1_COMPLETE.md) for full details

### Phase 2: Core Tools (1 week)
1. Browser tools (reuse Cursor MCP server)
2. Papr Memory tools
3. Jobs tool
4. Document management tools

### Phase 3: Advanced Features (2 weeks)
1. Apps/Mini-apps system
2. Skills framework
3. Sub-agents
4. Planning tools

### Phase 4: Premium (Future)
1. OAuth integrations
2. Webview tools
3. Advanced automation

---

## V2 Advantages (Don't Lose These!)

Despite having fewer tools, V2 is already better in these ways:

✅ **Type Safety** - Zod schemas, TypeScript types  
✅ **Better Error Handling** - Structured ToolResult  
✅ **Automatic Validation** - Mastra validates inputs  
✅ **Clean Architecture** - No manual switch statements  
✅ **Tool Registry** - Easy to add new tools  
✅ **Modular Design** - Each tool in its own file

---

## Action Plan

### Today:
1. **Add safety features** (truncation, sanitization, key substitution)
2. **Test existing 5 tools** in the UI
3. **Update test suite** for new message format

### This Week:
1. **Browser tools** (6 tools) - Reuse MCP server
2. **Papr Memory tools** (3 tools)
3. **Jobs tool** (1 tool, multiple actions)

### Next Week:
1. **Document tools** (4 tools)
2. **Apps system** (8 tools)
3. **Skills framework** (2 tools)

**Total Timeline:** 2-3 weeks to match V1's tool coverage

---

## Critical Security Note

⚠️ **URGENT:** Implement error sanitization ASAP

V1 has `sanitizeError()` to prevent API keys from appearing in:
- Error messages
- Tool results
- Bash output
- Console logs
- UI displays

V2 currently has **NO sanitization** - this is a security risk!

**Fix:** Add sanitization in `AgentService.ts` before streaming any tool results to UI.
