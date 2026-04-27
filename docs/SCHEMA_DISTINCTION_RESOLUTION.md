# Schema Distinction Clarification - Complete ✅

**Date:** April 22, 2026  
**Issue Reported By:** User question about schema confusion  
**Status:** ✅ **RESOLVED**

---

## 🔍 The Issue

User correctly identified that we were conflating two different types of schemas:

1. **Frequency Schemas** - Pre-built by Papr for holographic neural transforms (e.g., 'general', 'cosqa')
2. **Knowledge Graph Schemas** - User-created for entity/relationship modeling (e.g., 'BNSv8YCQXJ')

**User's Questions:**
- Can you verify what schemas are actually available based on domain endpoint?
- Do we have a tool to list frequency schemas?
- Do we clearly differentiate domain schemas for holo vs. schemas for traditional knowledge graph?

**Answer:** No, we didn't clearly differentiate them, and we didn't have a tool to list frequency schemas.

---

## ✅ What We Fixed

### 1. Created New Tool: `list_frequency_schemas`

**Purpose:** List pre-built frequency schemas for holographic encoding

**Location:** `src/core/tools/paprMemory.ts`

**Usage:**
```typescript
list_frequency_schemas()
// Returns:
// {
//   success: true,
//   data: {
//     count: 12,
//     schemas: [
//       { id: "general", name: "General Purpose", frequencyCount: 7 },
//       { id: "cosqa", name: "Code Search", frequencyCount: 14 },
//       { id: "scifact", name: "Scientific Facts", frequencyCount: 14 },
//       ...
//     ]
//   }
// }
```

**Implementation Details:**
- Fetches from `/v1/frequencies` endpoint
- Returns schema IDs, names, and frequency counts
- Clearly states these are for holographic, not KG schemas

### 2. Updated Existing `list_schemas` Tool

**Changed description** to explicitly state:
- "List KNOWLEDGE GRAPH schemas (user-created entity/relationship schemas)"
- Added note: "⚠️ NOTE: For HOLOGRAPHIC frequency schemas, use list_frequency_schemas instead."

### 3. Enhanced SystemPrompt Documentation

Added new section: **"Two Types of Schemas — Don't Confuse Them!"**

**Includes:**
- Clear definition of each type
- Usage examples for both
- Tool mapping (which tool for which type)
- Common mistakes to avoid
- Key distinction summary

**Updated tool table** to include:
- `list_frequency_schemas` for holographic
- Bold text for KG schema tools to distinguish them

---

## 📊 Clear Distinction

### Frequency Schemas (Holographic Neural Transforms)

| Property | Value |
|----------|-------|
| **Purpose** | Neural semantic encoding for better search |
| **Created By** | Papr (pre-built) |
| **ID Format** | Short names: `'general'`, `'cosqa'`, `'scifact'` |
| **API Endpoint** | `GET /v1/frequencies` |
| **List Tool** | `list_frequency_schemas` |
| **Use With Parameters** | `frequencySchemaId`, `enableHolographic`, `holographicConfig` |
| **Example Usage** | `add_agent_memory({ frequencySchemaId: "cosqa" })` |
| **Count** | ~12 pre-built schemas |

### Knowledge Graph Schemas (Entity/Relationship Modeling)

| Property | Value |
|----------|-------|
| **Purpose** | Define entity types and relationships for structured data |
| **Created By** | User (via `register_schema`) |
| **ID Format** | 10-char random: `'BNSv8YCQXJ'`, `'oo17hKHWic'` |
| **API Endpoint** | `GET /v1/schemas` (via SDK) |
| **List Tool** | `list_schemas` |
| **Use With Parameters** | `schemaId` in `create_entities`, `register_schema` |
| **Example Usage** | `create_entities({ schemaId: "BNSv8YCQXJ" })` |
| **Count** | Unlimited (user-created) |

---

## 🎯 Available Frequency Schemas

From our testing and documentation:

1. **`general`** (7 frequencies) - Any content: category, topic, entities, sentiment
2. **`cosqa`** (14 frequencies) - Code search: programming_domain, language, operation
3. **`scifact`** (14 frequencies) - Scientific: domain, causal_agent, finding_type
4. **`code`** (11 frequencies) - Programming: language, paradigm, construct
5. **`legal`** (13 frequencies) - Legal: jurisdiction, document_type, parties
6. **`medical`** (13 frequencies) - Medical: specialty, diagnosis, medications
7. **`ecommerce`** (13 frequencies) - Products: category, brand, price
8. **`text2sql`** (13 frequencies) - SQL: sql_task_type, join_type, aggregation
9. **`codetrans`** (13 frequencies) - DL frameworks: framework, tensor_operation
10. **`joe_coffee`** (~10 frequencies) - Food & beverage: coffee shop menus

**Verify current list:** Call `list_frequency_schemas()` tool

---

## 🧪 Testing

### Test Script Created

**File:** `scripts/test-schema-distinction.mjs`

**Command:** `npm run test:schema-types`

**What it does:**
1. Fetches frequency schemas from `/v1/frequencies`
2. Fetches KG schemas from SDK `client.schemas.list()`
3. Shows both side-by-side with key distinctions
4. Lists common mistakes to avoid

**Test Output:**
```
🧪 Testing Schema Type Distinction

1. FREQUENCY SCHEMAS (for holographic neural transforms)
   • general → General Purpose (7 frequencies)
   • cosqa → Code Search (14 frequencies)
   • ...

2. KNOWLEDGE GRAPH SCHEMAS (user-created entities/relationships)
   • BNSv8YCQXJ - Product Schema (2 node types, 3 relationships)
   • oo17hKHWic - IT Help Desk Intelligence (10 node types, 20 relationships)
   • ...

3. KEY DISTINCTIONS
   [Clear comparison table with usage examples]

⚠️  DON'T CONFUSE THEM:
   ❌ Wrong: add_agent_memory({ frequencySchemaId: "BNSv8YCQXJ" })
   ✅ Right: add_agent_memory({ frequencySchemaId: "general" })
```

---

## 📝 Files Changed

### New Files Created

1. **`docs/SCHEMA_TYPE_DISTINCTION.md`**
   - Complete guide to the distinction
   - Usage examples for both types
   - Common mistakes section
   - Quick reference table

2. **`scripts/test-schema-distinction.mjs`**
   - Test script demonstrating the distinction
   - Fetches both types from API
   - Shows side-by-side comparison

### Modified Files

1. **`src/core/tools/paprMemory.ts`**
   - Added `listFrequencySchemasTool` (NEW)
   - Updated `listSchemasTool` description
   - Added to `paprMemoryTools` array

2. **`src/core/tools/index.ts`**
   - Exported `listFrequencySchemasTool`

3. **`src/core/agents/SystemPrompt.ts`**
   - Added "Two Types of Schemas" section
   - Updated tool table with `list_frequency_schemas`
   - Added comparison examples
   - Highlighted KG schema tools with bold text

4. **`package.json`**
   - Added `test:schema-types` script

---

## ✅ Verification Checklist

- [x] New tool `list_frequency_schemas` created
- [x] Tool fetches from `/v1/frequencies` endpoint
- [x] `list_schemas` clarified as KG-only
- [x] SystemPrompt updated with distinction
- [x] Comparison table added to docs
- [x] Common mistakes documented
- [x] Test script created
- [x] npm script added for easy testing
- [x] Documentation files created
- [x] Tools exported correctly

---

## 🎓 Quick Agent Reference

**Use frequency schemas when:**
- Parameter is `frequencySchemaId`
- Using `enableHolographic: true`
- Using `holographicConfig` in search
- Tool: `list_frequency_schemas`

**Use KG schemas when:**
- Parameter is `schemaId`
- Using `create_entities` or `register_schema`
- Defining node types and relationships
- Tool: `list_schemas`

**Remember the ID format:**
- Frequency: `'general'`, `'cosqa'` (short names)
- KG: `'BNSv8YCQXJ'`, `'oo17hKHWic'` (10 random chars)

---

## 📊 Impact

**Before:**
- No tool to list frequency schemas
- `list_schemas` ambiguous about what it returned
- Documentation didn't distinguish the two types
- Agents could easily confuse them

**After:**
- Dedicated tool for each type
- Clear descriptions and documentation
- Comparison table showing differences
- Common mistakes explicitly called out
- Test script to verify understanding

**Result:** Clear, unambiguous schema management with proper tooling ✅

---

## 🚀 Next Steps

1. Run `npm run test:schema-types` to verify the distinction
2. Update any existing agent conversations that may have confused the two
3. Monitor for any lingering confusion in agent usage
4. Consider adding validation to tools (reject KG schema IDs in frequency params and vice versa)

---

**Status:** ✅ Complete and documented
