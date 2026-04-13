# Tool Result Truncation - Quick Reference

## Problem
Agent said "I don't have get_schema tool" and `list_schemas` was truncating with 50K+ chars.

## Root Causes
1. ❌ **Missing `get_schema` tool** - Papr Memory API has it, we didn't wrap it
2. ⚠️ **`list_schemas` returns full objects** - All schemas with full node types/relationships
3. 🤷 **Passive truncation messages** - Agent couldn't access full results after truncation

## Solutions Implemented

### 1. Added `get_schema` Tool ✅
```typescript
// Before: Only list_schemas (returns everything, gets truncated)
list_schemas() // 50K chars → truncated to 2KB in context

// After: Two-step workflow
list_schemas() // Lightweight: ~500 chars (id, name, description, nodeTypeCount)
get_schema({ schemaId: "BNSv8YCQXJ" }) // Full details: ~3KB (fits in context)
```

### 2. Made `list_schemas` Lightweight ✅
Returns summary instead of full objects:
```json
{
  "count": 47,
  "schemas": [
    {
      "id": "BNSv8YCQXJ",
      "name": "SalesIntelligence",
      "description": "...",
      "nodeTypeCount": 10,
      "relationshipCount": 9
    }
  ],
  "note": "Use get_schema(schemaId) to fetch full details"
}
```

### 3. Made Truncation Messages Actionable ✅

**Before (passive):**
```
[... 5000 chars truncated]
```

**After (actionable):**
```
[... 5000 chars truncated. Full result available via: 
get_full_tool_result({ toolCallId: "toolu_abc123", searchIn: "current_chat" })]
```

**New tool:** `get_full_tool_result`
- Searches chat history by `toolCallId`
- Supports pagination: `{ startChar: 0, length: 50000 }`
- Returns metadata: `totalLength`, `hasMore`, `nextStartChar`

## Usage Examples

### Schema Discovery (No Truncation)
```typescript
// 1. Get overview
list_schemas()
// Returns: { schemas: [{ id, name, nodeTypeCount }] } // ~500 chars

// 2. Get full details for one
get_schema({ schemaId: "BNSv8YCQXJ" })
// Returns: { node_types: [...], relationships: [...] } // ~3KB, fits in context
```

### Large Tool Result Recovery
```typescript
// 1. Tool result gets truncated
bash({ command: "find ~/Papr -name '*.py'" })
// [First 200KB shown, ... 800KB truncated. Use get_full_tool_result({ toolCallId: "toolu_456" })]

// 2. Get full result
get_full_tool_result({ toolCallId: "toolu_456" })
// Returns: Full 1MB output

// 3. Or paginate
get_full_tool_result({ toolCallId: "toolu_456", startChar: 200000, length: 100000 })
// Returns: Chars 200K-300K (next 100KB section)
```

## Files Changed
- `src/core/tools/paprMemory.ts` - Added `get_schema`, lightweight `list_schemas`
- `src/core/tools/chatHistory.ts` - NEW: `get_full_tool_result` tool
- `src/core/tools/index.ts` - Exported new tools
- `src/gateway/services/agent/historyFormatter.ts` - Actionable truncation messages
- `src/gateway/services/AgentService.ts` - Actionable truncation messages

## Impact
| Issue | Before | After |
|-------|--------|-------|
| "I don't have get_schema" | ❌ True (missing) | ✅ Fixed (added) |
| list_schemas truncated | ⚠️ 50K chars → 2KB | ✅ 500 chars (no truncation) |
| Agent stuck on truncation | ❌ No recourse | ✅ Can query for more |
| Large results | All or nothing | Paginated access |

## Key Insight
**Don't just truncate - tell the agent HOW to get more.**

Actionable error messages turn roadblocks into next steps.
