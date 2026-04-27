# Schema Type Distinction - Frequency vs Knowledge Graph

**Created:** 2026-04-22  
**Issue:** We were conflating two completely different types of schemas

---

## 🔍 The Problem

Originally, our documentation and tools didn't clearly distinguish between:

1. **Frequency Schemas** - Pre-built by Papr for holographic neural transforms
2. **Knowledge Graph Schemas** - User-created for entity/relationship modeling

This led to potential confusion about which schema IDs to use where.

---

## ✅ The Solution

### 1. New Tool: `list_frequency_schemas`

Created a dedicated tool to list frequency schemas (for holographic):

```typescript
list_frequency_schemas()
// Returns: ['general', 'cosqa', 'scifact', 'code', 'legal', 'medical', ...]
```

### 2. Clarified Existing Tools

**`list_schemas`** now explicitly states:
- "List KNOWLEDGE GRAPH schemas (user-created entity/relationship schemas)"
- Points to `list_frequency_schemas` for holographic schemas

### 3. Updated Documentation

Added clear distinction section in SystemPrompt explaining:
- What each type is for
- How to list them
- Example usage
- What NOT to do (common mistakes)

---

## 📊 Comparison Table

| Feature | Frequency Schemas | Knowledge Graph Schemas |
|---------|-------------------|------------------------|
| **Purpose** | Neural semantic encoding for better search | Define entity types and relationships |
| **Created By** | Papr (pre-built) | You (via register_schema) |
| **ID Format** | Short names: `'general'`, `'cosqa'`, `'scifact'` | 10-char random: `'BNSv8YCQXJ'`, `'oo17hKHWic'` |
| **List Tool** | `list_frequency_schemas` | `list_schemas` |
| **Count** | ~12 pre-built | Unlimited (user-created) |
| **Used With** | `frequencySchemaId` parameter | `schemaId` parameter |
| **Example** | `enableHolographic: true, frequencySchemaId: "cosqa"` | `create_entities({ schemaId: "BNSv8YCQXJ" })` |

---

## 🎯 Correct Usage Examples

### Frequency Schemas (Holographic)

```typescript
// ✅ CORRECT: Use frequency schema for holographic encoding
add_agent_memory({
  content: "Python code for CSV parsing",
  enableHolographic: true,
  frequencySchemaId: "cosqa", // ← Frequency schema
  metadata: { role: "user", category: "fact" }
})

search_agent_memory({
  query: "how to parse CSV",
  holographicConfig: {
    enabled: true,
    frequencySchemaId: "cosqa", // ← Same frequency schema
    includeFrequencyScores: true
  }
})

// List available frequency schemas
list_frequency_schemas()
// Returns: ['general', 'cosqa', 'scifact', ...]
```

### Knowledge Graph Schemas (Entity/Relationship)

```typescript
// ✅ CORRECT: Use KG schema for structured entities
register_schema({
  name: "Product Schema",
  node_types: {
    Product: { properties: { name: "string", price: "number" } },
    Company: { properties: { name: "string" } }
  },
  relationship_types: {
    MANUFACTURED_BY: { 
      allowed_source_types: ["Product"],
      allowed_target_types: ["Company"]
    }
  }
})

create_entities({
  content: "Product catalog data",
  schemaId: "BNSv8YCQXJ", // ← KG schema ID (from register_schema)
  nodes: [
    { id: "prod1", label: "Product", properties: { name: "Widget", price: 99 } },
    { id: "comp1", label: "Company", properties: { name: "Acme Corp" } }
  ],
  relationships: [
    { sourceNodeId: "prod1", targetNodeId: "comp1", relationshipType: "MANUFACTURED_BY" }
  ]
})

// List your KG schemas
list_schemas()
// Returns: [{ id: "BNSv8YCQXJ", name: "Product Schema", nodeTypeCount: 2, ... }]
```

---

## ❌ Common Mistakes (What NOT to Do)

### Mistake 1: Using KG Schema ID for Holographic

```typescript
// ❌ WRONG: BNSv8YCQXJ is a KG schema, not a frequency schema
add_agent_memory({
  enableHolographic: true,
  frequencySchemaId: "BNSv8YCQXJ" // Wrong type!
})
```

**Fix:**
```typescript
// ✅ RIGHT: Use frequency schema name
add_agent_memory({
  enableHolographic: true,
  frequencySchemaId: "general" // Correct!
})
```

### Mistake 2: Using Frequency Schema for Entity Creation

```typescript
// ❌ WRONG: 'cosqa' is a frequency schema, not a KG schema
create_entities({
  schemaId: "cosqa", // Wrong type!
  nodes: [...]
})
```

**Fix:**
```typescript
// ✅ RIGHT: Use KG schema ID
create_entities({
  schemaId: "BNSv8YCQXJ", // Correct!
  nodes: [...]
})
```

### Mistake 3: Confusing the List Tools

```typescript
// ❌ WRONG: list_schemas returns KG schemas, not frequency schemas
const freqSchemas = await list_schemas()
// Returns: [{ id: "BNSv8YCQXJ", name: "Product Schema", ... }]
// These are NOT frequency schemas!
```

**Fix:**
```typescript
// ✅ RIGHT: Use correct tool for each type
const freqSchemas = await list_frequency_schemas()
// Returns: [{ id: "general", frequencyCount: 7, ... }]

const kgSchemas = await list_schemas()
// Returns: [{ id: "BNSv8YCQXJ", name: "Product Schema", ... }]
```

---

## 🔧 Available Frequency Schemas

Based on earlier testing, these frequency schemas are available:

| ID | Name | Frequencies | Best For |
|----|------|-------------|----------|
| `general` | General Purpose | 7 | Any content type |
| `cosqa` | Code Search | 14 | Python/JS code Q&A |
| `scifact` | Scientific Facts | 14 | Research papers, biomedical |
| `code` | Programming | 11 | Code snippets, algorithms |
| `legal` | Legal Documents | 13 | Contracts, agreements |
| `medical` | Medical Records | 13 | Clinical notes, diagnoses |
| `ecommerce` | E-commerce | 13 | Product catalogs, reviews |
| `text2sql` | SQL Queries | 13 | Database queries |
| `codetrans` | Code Translation | 13 | Deep learning frameworks |
| `joe_coffee` | Food & Beverage | ~10 | Coffee shop menus |

**To verify:** Call `list_frequency_schemas()` tool for the latest list from API.

---

## 📝 Implementation Details

### Files Changed

1. **`src/core/tools/paprMemory.ts`**:
   - Added `listFrequencySchemasTool` - New tool to list frequency schemas
   - Updated `listSchemasTool` description to clarify it's for KG schemas only
   - Added to `paprMemoryTools` array

2. **`src/core/tools/index.ts`**:
   - Exported `listFrequencySchemasTool`

3. **`src/core/agents/SystemPrompt.ts`**:
   - Added new section "Two Types of Schemas — Don't Confuse Them!"
   - Added `list_frequency_schemas` to tool table
   - Clarified KG schema tools with bold text
   - Added comparison examples

4. **`scripts/test-schema-distinction.mjs`**:
   - Created test script to demonstrate the distinction
   - Shows both types side-by-side
   - Lists common mistakes

---

## ✅ Testing

Run the test script to see the distinction in action:

```bash
node scripts/test-schema-distinction.mjs
```

**Expected Output:**
- Section 1: Lists frequency schemas from `/v1/frequencies` endpoint
- Section 2: Lists your KG schemas from `client.schemas.list()`
- Section 3: Shows key distinctions and common mistakes

---

## 🎓 Quick Reference for Agents

**When to use frequency schemas:**
- Adding memories with `enableHolographic: true`
- Searching with `holographicConfig`
- Need semantic frequency-based scoring
- Tool: `list_frequency_schemas`

**When to use KG schemas:**
- Creating structured entities and relationships
- Defining custom node types and relationship types
- Need graph traversal and queries
- Tools: `register_schema`, `list_schemas`, `create_entities`

**Remember:**
- Frequency schema IDs: short names (`'general'`, `'cosqa'`)
- KG schema IDs: 10-char random (`'BNSv8YCQXJ'`)
- Different endpoints: `/v1/frequencies` vs `/v1/schemas`
- Different purposes: semantic encoding vs graph modeling
