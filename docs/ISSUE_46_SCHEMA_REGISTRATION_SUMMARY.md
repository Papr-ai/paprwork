# Papr Memory Schema Registration Fix - Summary

**Issue #46** - Fixed on 2026-04-11

---

## Problem

The `register_schema` tool was not persisting `node_types` and `relationship_types`. When agents called the tool, schemas were registered but completely empty (zero entities, zero relationships).

### What Users Saw

```typescript
// Agent tries to register schema
register_schema({
  name: "PM Schema",
  node_types: { "Company": {...}, "Contact": {...} }
})
// ✓ Schema registered

// But when checking...
get_schema({ schemaId: "abc123" })
// Returns: { node_types: {}, relationship_types: {} } ❌ EMPTY!
```

---

## Root Cause

The tool's Zod schema only validated 2 fields:
- ✅ `name` (string)
- ✅ `description` (optional string)
- ❌ `node_types` (IGNORED - not in schema!)
- ❌ `relationship_types` (IGNORED - not in schema!)

Even though the Papr Memory API **does accept** these fields, our tool wasn't passing them through.

---

## Solution

Enhanced the `register_schema` tool to accept full schema definitions:

### 1. Enhanced Validation (Lines 7-62 in paprMemory.ts)

Added complete Zod schemas for:
- `PropertyDefinition` - type, validation rules, enums
- `NodeType` - entity types with properties
- `RelationshipType` - connections between entities

### 2. Enhanced Tool Implementation (Lines 272-330)

```typescript
const createParams: SchemaCreateParams = {
  name: args.name,
  ...(args.node_types && { node_types: args.node_types }),
  ...(args.relationship_types && { relationship_types: args.relationship_types }),
  ...(args.status && { status: args.status }),
  ...(args.scope && { scope: args.scope }),
};

const response = await client.schemas.create(createParams);
```

### 3. Added `update_schema` Tool (Lines 332-370)

Allows updating existing schemas (add types, change status, update scope).

---

## Usage

### Complete Schema (Recommended)

```typescript
register_schema({
  name: "Product Management",
  description: "Track products and companies",
  status: "active", // Activate immediately
  scope: "namespace",
  node_types: {
    "Company": {
      name: "Company",
      label: "Company",
      properties: {
        "name": { type: "string", required: true },
        "industry": { type: "string" }
      },
      resolution_policy: "upsert",
      unique_identifiers: ["name"]
    }
  },
  relationship_types: {
    "WORKS_AT": {
      name: "WORKS_AT",
      label: "Works At",
      allowed_source_types: ["Contact"],
      allowed_target_types: ["Company"]
    }
  }
})
```

### Update Existing Schema

```typescript
update_schema({
  schemaId: "abc123",
  status: "active", // Activate it
  node_types: { /* add or update types */ }
})
```

---

## Testing

Run the test script:

```bash
npm run test:schema-registration
```

This will:
1. Create a test schema with 2 node types
2. Verify node types persisted
3. Update schema status
4. Clean up (archive test schema)

Expected output:
```
✅ Schema created: abc123
✅ Node types persisted correctly
✅ Schema updated to active
✅ ALL TESTS PASSED
```

---

## Files Changed

- **`src/core/tools/paprMemory.ts`**
  - Added `PropertyDefinition` schema (lines 7-18)
  - Added `NodeType` schema (lines 20-30)
  - Added `RelationshipType` schema (lines 32-42)
  - Enhanced `registerSchemaSchema` (lines 44-62)
  - Enhanced `registerSchemaTool` (lines 272-330)
  - Added `updateSchemaTool` (lines 332-370)
  - Exported new tool (line 630)

- **`package.json`**
  - Added test script: `test:schema-registration`

- **`docs/PAPR_MEMORY_SCHEMA_REGISTRATION_FIX.md`**
  - Complete documentation with examples

- **`scripts/test-schema-registration.mjs`**
  - Automated test suite

- **`CLAUDE.md`**
  - Added Issue #46 documentation

---

## Before vs After

| Aspect | Before | After |
|--------|--------|-------|
| Tool parameters accepted | 2 (`name`, `description`) | 6 (name, description, node_types, relationship_types, status, scope) |
| Node types persist | ❌ No (always empty) | ✅ Yes |
| Relationship types persist | ❌ No (always empty) | ✅ Yes |
| Validation | Minimal (2 fields) | Complete (15+ fields) |
| Functionality | Creates shell only | Creates complete schema |
| Python SDK parity | ❌ No | ✅ Yes |
| Workarounds needed | ✅ (use Python SDK) | ❌ None |

---

## Schema Limits (Papr Memory API)

- Maximum **10 node types** per schema
- Maximum **20 relationship types** per schema
- Maximum **10 properties** per node type
- Maximum **15 enum values** per property

---

## Key Takeaways

1. **Always pass `node_types`** when calling `register_schema` - otherwise you get an empty shell
2. **Use `status: "active"`** to immediately enable the schema
3. **Use `update_schema`** to modify existing schemas incrementally
4. **Tool now matches Python SDK** - full parity, no workarounds needed

---

## Related Issues

- **Enhancement 45** (Actionable Tool Truncation) - Added `get_schema` tool for fetching full schema details
- This fix makes schema registration a complete workflow: register → verify → update → activate

---

## Impact

### Before Fix
- ❌ Schemas empty (node_types: {})
- ❌ Required Python SDK workaround
- ❌ Poor agent experience ("tool doesn't work")
- ❌ No way to update schemas

### After Fix
- ✅ Complete schemas in one tool call
- ✅ Full validation with helpful errors
- ✅ Matches Python SDK functionality
- ✅ Can update schemas incrementally
- ✅ Professional agent experience

---

**Status:** ✅ Fixed and tested  
**Version:** Paprwork v2.0  
**Date:** 2026-04-11
