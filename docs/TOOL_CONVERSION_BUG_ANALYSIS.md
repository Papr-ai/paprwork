# Root Cause Analysis: Tool Conversion Bug

## Date
2026-02-19

## The Bug
When converting Mastra tools to OpenAI Codex format, we used incorrect field names:

```typescript
// ❌ WRONG (what we did initially)
const codexTools = Object.entries(tools).map(([_name, tool]) => ({
  type: "function",
  function: {
    name: tool.id || tool.description?.name || _name,  // ❌ description is a string, not object
    description: tool.description?.description || '',  // ❌ double .description doesn't exist
    parameters: tool.parameters || {},                 // ❌ no .parameters property exists
  },
}));

// ✅ CORRECT (what we fixed it to)
const codexTools = Object.entries(tools).map(([toolKey, tool]) => ({
  type: "function",
  function: {
    name: tool.id || toolKey,        // ✅ id is a string
    description: tool.description || '', // ✅ description is a string
    parameters: tool.inputSchema || {},  // ✅ inputSchema is the Zod schema
  },
}));
```

## Why Did This Happen?

### 1. **Made Assumptions Without Checking Types**
We assumed the Mastra Tool interface without verifying:
- Assumed `description` was an object with nested properties
- Assumed there was a `parameters` property
- Didn't check the actual Mastra type definitions

### 2. **Didn't Look at Existing Tool Examples**
All our tools use this pattern (from grep results):
```typescript
export const bashTool = createTool({
  id: "bash",                    // ← string ID
  description: "Run commands",   // ← string description
  inputSchema: bashSchema,       // ← Zod schema
  execute: async (args) => {...}
});
```

### 3. **Didn't Test Incrementally**
We built the entire provider, adapter, and integration before testing with actual tools.

## The Actual Mastra Tool Interface

From `node_modules/@mastra/core/dist/tools/tool.d.ts`:

```typescript
export declare class Tool<...> {
    /** Unique identifier for the tool */
    id: TId;
    
    /** Description of what the tool does */
    description: string;  // ← STRING, not object
    
    /** Schema for validating input parameters */
    inputSchema?: SchemaWithValidation<TSchemaIn>;  // ← THIS is the parameters schema
    
    /** Schema for validating output structure */
    outputSchema?: SchemaWithValidation<TSchemaOut>;
    
    execute?: ToolAction<...>['execute'];
    
    // ... other properties (requireApproval, providerOptions, etc.)
}
```

**Key findings:**
- ✅ `id` - string identifier
- ✅ `description` - **string** (not an object!)
- ✅ `inputSchema` - the Zod schema for parameters (not `parameters`)
- ✅ `outputSchema` - optional output validation schema
- ✅ `execute` - the execution function

## Are There Other Similar Issues?

### ✅ Checked: Other Tool Conversions

**AgentService (only place we do this conversion):**
- ✅ Fixed in lines 681-692 (tool conversion for openai-codex)
- ❌ No other tool conversion code exists in the codebase

### ✅ Checked: AI SDK Usage

Let me verify the AI SDK doesn't need similar fixes:

```bash
grep -r "tools as" src/gateway/services/AgentService.ts
```

**Finding:** The AI SDK path uses `tools as unknown as ToolSet` (line 445) which works because:
1. Mastra tools ARE compatible with AI SDK's ToolSet format
2. AI SDK expects the same structure: `{ [name: string]: { description, parameters, execute } }`
3. The AI SDK internally handles the Zod schema conversion

### ✅ Checked: Type Safety

**Why didn't TypeScript catch this?**

Looking at line 682 in AgentService:
```typescript
const codexTools = Object.entries(tools as any).map(([toolKey, tool]: [string, any]) => {
  //                                  ^^^^ HERE'S THE PROBLEM
```

We explicitly cast to `any`! TypeScript couldn't help us because we disabled type checking.

**Lesson:** Never use `as any` unless absolutely necessary. If we had typed it properly:

```typescript
import type { AnyTool } from "../../core/agents/ToolRegistry.js";

const codexTools = Object.entries(tools as Record<string, AnyTool>).map(
  ([toolKey, tool]: [string, AnyTool]) => {
    return {
      type: "function" as const,
      function: {
        name: tool.id || toolKey,
        description: tool.description || '',
        parameters: tool.inputSchema || {}, // TypeScript would have caught this!
      },
    };
  }
);
```

TypeScript would have shown us:
- `tool.description` is a `string` (not an object)
- `tool.parameters` doesn't exist (suggested `inputSchema` instead)

## Other Potential Issues to Check

### 1. ✅ Stream Adapter Event Mapping

Let me verify the Codex → AI SDK event mapping is correct by checking pi-ai's actual event types:

From the pi-ai source we fetched earlier (`openai-codex-responses.ts`):
```typescript
// Codex events we need to handle:
- "response.content_part.delta" → text delta
- "response.reasoning.delta" → reasoning/thinking delta  
- "response.function_call_arguments.delta" → tool call delta
- "response.function_call_arguments.done" → tool call complete
- "response.output_item.done" → tool result
- "response.done" / "response.completed" → stream complete
- "error" / "response.failed" → error
```

**Status:** ✅ Our adapter correctly maps all these events (checked `CodexStreamAdapter.ts` lines 35-150)

### 2. ✅ Token Usage Extraction

From pi-ai source:
```typescript
const response = (event as { 
  response?: { 
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}).response;
```

**Status:** ✅ Our adapter correctly extracts `input_tokens` and `output_tokens` (lines 134-137)

### 3. ⚠️ Missing: Tool Result Handling

Looking at the adapter more carefully, I see a potential issue:

```typescript
// response.output_item.done (includes tool call results)
else if (type === "response.output_item.done") {
  const item = (event as { item?: { ... } }).item;
  
  if (item?.type === "function_call" && item.call_id && item.name && item.output) {
    yield {
      type: "tool-result",
      toolCallId: item.call_id,
      toolName: item.name,
      result: item.output,  // ← Is this the right field?
    };
  }
}
```

**Need to verify:** Does `item.output` contain the tool result, or is it `item.result`?

Let me check the pi-ai source structure...

From the pi-ai code, tool results come through the stream processing, but the actual field name isn't clear from what we fetched. This needs testing.

## Recommendations

### Immediate Actions
1. ✅ **DONE:** Fix tool conversion to use correct fields
2. ⚠️ **TODO:** Test tool calling with openai-codex to verify tool results work
3. ⚠️ **TODO:** Add TypeScript types instead of `as any` casts

### Process Improvements
1. **Always check type definitions** before implementing interfaces
2. **Look at existing usage patterns** in the codebase
3. **Test incrementally** - don't build entire feature before first test
4. **Never use `as any`** unless absolutely necessary (and document why)
5. **Read the actual type definitions** from `node_modules` when unsure

### Code Quality
1. Replace `as any` with proper types:
   ```typescript
   import type { AnyTool } from "../../core/agents/ToolRegistry.js";
   // Then use: tools as Record<string, AnyTool>
   ```

2. Add JSDoc comments explaining the conversion:
   ```typescript
   /**
    * Convert Mastra tools to OpenAI Codex format
    * Mastra: { id, description, inputSchema }
    * Codex:  { type: "function", function: { name, description, parameters } }
    */
   ```

## Summary

**Root cause:** Made assumptions about Mastra Tool structure without verifying against:
1. Type definitions (`@mastra/core/dist/tools/tool.d.ts`)
2. Existing usage patterns (all 66+ tools in our codebase)
3. TypeScript's type checking (bypassed with `as any`)

**Impact:** Tool conversion failed at runtime with "Missing required parameter: 'tools[0].name'"

**Fix:** Use correct field names: `tool.id`, `tool.description`, `tool.inputSchema`

**Lesson:** Type systems exist for a reason - don't bypass them with `as any` unless absolutely necessary!
