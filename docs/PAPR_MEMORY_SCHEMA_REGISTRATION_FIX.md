# Papr Memory Schema Registration Fix

**Date:** 2026-04-11  
**Issue:** `register_schema` tool not persisting `node_types` and `relationship_types`  
**Status:** ✅ FIXED

---

## Problem

The `register_schema` tool was only accepting `name` and `description` parameters, creating incomplete "shell" schemas with no entity types or relationships. When agents called the tool, the schema was registered but had zero node types and zero relationships, making it unusable.

### Why It Happened

The tool's Zod schema was too limited - it only validated `name` and `description` even though the Papr Memory API accepts full schema definitions including:
- `node_types` (entity types like Company, Contact, Product)
- `relationship_types` (connections like WORKS_AT, MANAGES, PURCHASES)
- `status` (draft or active)
- `scope` (personal, workspace, namespace, organization)

### User Experience Before Fix

```typescript
// Agent tries to register schema
register_schema({
  name: "Product Management Schema",
  description: "Track products, contacts, and companies",
  node_types: {
    "Company": { name: "Company", label: "Company", ... },
    "Contact": { name: "Contact", label: "Contact", ... }
  }
})

// Result: Schema created but node_types = {} (empty!)
get_schema({ schemaId: "abc123" })
// Returns: { name: "Product Management Schema", node_types: {}, relationship_types: {} }
```

---

## Solution

Enhanced the `register_schema` tool to accept full schema definitions:

### 1. Enhanced Zod Schema Validation

Added complete validation for node types and relationship types:

```typescript
// Property definition
const propertyDefinitionSchema = z.object({
  type: z.enum(['string', 'integer', 'float', 'boolean', 'array', 'datetime', 'object']),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  enum_values: z.array(z.string()).max(15).optional(),
  // ... validation rules
});

// Node type
const nodeTypeSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  properties: z.record(z.string(), propertyDefinitionSchema).optional(),
  resolution_policy: z.enum(['upsert', 'lookup']).optional(),
  unique_identifiers: z.array(z.string()).optional(),
});

// Relationship type
const relationshipTypeSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  allowed_source_types: z.array(z.string()).min(1),
  allowed_target_types: z.array(z.string()).min(1),
  properties: z.record(z.string(), propertyDefinitionSchema).optional(),
  cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-many']).optional(),
});

// Full schema registration
const registerSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  node_types: z.record(z.string(), nodeTypeSchema).optional(),
  relationship_types: z.record(z.string(), relationshipTypeSchema).optional(),
  status: z.enum(['draft', 'active']).optional(),
  scope: z.enum(['personal', 'workspace', 'namespace', 'organization']).optional(),
});
```

### 2. Enhanced Tool Implementation

Updated the tool to pass through all schema fields to the API:

```typescript
const createParams: SchemaCreateParams = {
  name: args.name,
  ...(args.description && { description: args.description }),
  ...(args.node_types && { node_types: args.node_types as SchemaCreateParams['node_types'] }),
  ...(args.relationship_types && { relationship_types: args.relationship_types as SchemaCreateParams['relationship_types'] }),
  ...(args.status && { status: args.status }),
  ...(args.scope && { scope: args.scope }),
};

const response = await client.schemas.create(createParams);
```

### 3. Added `update_schema` Tool

Also created a companion tool for updating existing schemas:

```typescript
update_schema({
  schemaId: "abc123",
  node_types: { /* updated types */ },
  status: "active" // activate the schema
})
```

---

## Usage Examples

### Complete Schema Registration (Recommended)

```typescript
register_schema({
  name: "Product Management Schema",
  description: "Track products, companies, and contacts with their relationships",
  status: "active", // Activate immediately
  scope: "namespace", // Available to your namespace
  node_types: {
    "Company": {
      name: "Company",
      label: "Company",
      description: "A business entity",
      properties: {
        "name": {
          type: "string",
          required: true,
          description: "Company name"
        },
        "industry": {
          type: "string",
          description: "Industry sector"
        },
        "size": {
          type: "string",
          enum_values: ["startup", "small", "medium", "enterprise"],
          description: "Company size category"
        }
      },
      resolution_policy: "upsert", // Create if not found
      unique_identifiers: ["name"] // Deduplicate by name
    },
    "Contact": {
      name: "Contact",
      label: "Contact",
      description: "A person",
      properties: {
        "name": { type: "string", required: true },
        "email": { type: "string" },
        "role": { type: "string" }
      },
      resolution_policy: "upsert",
      unique_identifiers: ["email"]
    }
  },
  relationship_types: {
    "WORKS_AT": {
      name: "WORKS_AT",
      label: "Works At",
      description: "Person works at a company",
      allowed_source_types: ["Contact"],
      allowed_target_types: ["Company"],
      cardinality: "many-to-one",
      properties: {
        "start_date": { type: "datetime" },
        "role": { type: "string" }
      }
    }
  }
})
```

### Minimal Shell Schema (Then Update Later)

```typescript
// Step 1: Create shell
register_schema({
  name: "Product Management Schema",
  description: "Track products and companies"
})
// Returns: { schemaId: "abc123" }

// Step 2: Add node types
update_schema({
  schemaId: "abc123",
  node_types: { /* full definitions */ },
  status: "active"
})
```

---

## Key Differences: Before vs After

| Aspect | Before | After |
|--------|--------|-------|
| **Tool Input** | Only `name` + `description` | Full schema structure |
| **Node Types** | Not accepted (ignored) | ✅ Fully validated |
| **Relationships** | Not accepted (ignored) | ✅ Fully validated |
| **Result** | Empty shell schema | Complete functional schema |
| **Agent Experience** | Must use Python SDK | ✅ Works directly from tool |
| **Validation** | Minimal (2 fields) | ✅ Complete (15+ fields) |

---

## Schema Limits (Per Papr Memory API)

- **Maximum 10 node types** per schema
- **Maximum 20 relationship types** per schema
- **Maximum 10 properties** per node type
- **Maximum 15 enum values** per property

These limits are optimized for LLM performance.

---

## Property Types & Validation

### Supported Property Types

- `string` - Text values with optional `enum_values`, `min_length`, `max_length`, `pattern`
- `integer` - Whole numbers with optional `min_value`, `max_value`
- `float` - Decimal numbers with optional `min_value`, `max_value`
- `boolean` - True/false values
- `datetime` - ISO 8601 timestamp strings
- `array` - Lists of values
- `object` - Complex nested objects

### When to Use Enums

**✅ Use enums for:**
- Limited, well-defined options (≤15 values): sizes, statuses, categories
- Controlled vocabularies: "active/inactive", "high/medium/low"
- Exact matching requirements

**❌ Avoid enums for:**
- Open-ended text: names, titles, descriptions
- Large sets (>15): countries, cities, product models
- When you want semantic similarity matching
- Dynamic or frequently changing value sets

### Unique Identifiers & Entity Resolution

Properties marked as `unique_identifiers` are used for entity deduplication:

- **With enum_values**: Exact matching (entities with same enum value are identical)
- **Without enum_values**: Semantic similarity matching (entities with similar meanings merge)

**Examples:**
```typescript
// Semantic matching (no enums)
unique_identifiers: ["name"] // "Apple Inc" merges with "Apple Inc."

// Exact matching (with enums)
properties: {
  sku: {
    type: "string",
    enum_values: ["SKU-001", "SKU-002", "SKU-003"]
  }
},
unique_identifiers: ["sku"] // Only exact SKU matches merge
```

---

## Resolution Policies

Controls how nodes are created/linked:

- **`upsert` (default)**: Create node if not found, update if exists
- **`lookup`**: Only link to existing nodes (controlled vocabulary)

**Use `lookup` for:**
- Reference data (countries, languages, industries)
- Predefined taxonomies
- When you don't want new entities created automatically

**Use `upsert` for:**
- Dynamic entities (companies, contacts, products)
- When entities are discovered from content
- When you want automatic entity creation

---

## Status Management

- **`draft`** (default): Schema saved but not active, no indexing
- **`active`**: Schema activated, triggers Neo4j index creation, can be used for memory extraction
- **`deprecated`**: Schema marked as old, still usable but discouraged
- **`archived`**: Soft-deleted, preserved for data integrity

**Recommendation:** Start with `status: "draft"` to test, then update to `status: "active"` once confirmed.

---

## Scope Management

- **`personal`**: Only visible to you
- **`workspace`**: Shared within workspace (legacy)
- **`namespace`**: Shared within namespace (recommended)
- **`organization`**: Available to entire organization

**Recommendation:** Use `scope: "namespace"` for team collaboration.

---

## Testing the Fix

### 1. Register a Complete Schema

```typescript
const result = register_schema({
  name: "Test Schema",
  node_types: {
    "Person": {
      name: "Person",
      label: "Person",
      properties: {
        "name": { type: "string", required: true }
      }
    }
  }
});
// Should return: "Schema registered with 1 node types. Schema ID: xyz"
```

### 2. Verify Node Types Persisted

```typescript
get_schema({ schemaId: "xyz" });
// Should show: node_types: { Person: { ... } }
```

### 3. Update Schema

```typescript
update_schema({
  schemaId: "xyz",
  status: "active"
});
// Should activate the schema
```

---

## Related Files

- **Tool Implementation**: `src/core/tools/paprMemory.ts` (lines 94-340)
- **Code Schema Example**: `src/gateway/services/CodeSchemaRegistration.ts` (lines 480-530)
- **SDK Types**: `node_modules/@papr/memory/resources/schemas.d.ts`

---

## Impact

### Before Fix
- Agents couldn't create functional schemas via tools
- Had to use Python SDK workaround (requires job creation)
- Schema registration felt broken (node_types empty)

### After Fix
- ✅ Complete schema registration in one tool call
- ✅ Full validation with helpful error messages
- ✅ Matches Python SDK functionality
- ✅ No workarounds needed
- ✅ Can update schemas incrementally

---

## Best Practices

1. **Start with draft status**: Test schema structure before activating
2. **Use descriptive labels**: "Person" (label) vs "person_node" (name)
3. **Add property descriptions**: Guide the LLM on expected formats
4. **Limit enums**: Use for ≤15 controlled values only
5. **Choose resolution policy carefully**: `upsert` for dynamic, `lookup` for reference
6. **Namespace scope**: Share schemas with team via `scope: "namespace"`
7. **Update, don't recreate**: Use `update_schema` to modify existing schemas

---

## Future Enhancements

Potential improvements:

1. **Schema templates**: Pre-built schemas for common use cases (CRM, project management)
2. **Schema validation tool**: Check schema before registration
3. **Schema migration**: Copy schemas between namespaces
4. **Bulk import**: Register multiple schemas at once
5. **Visual editor**: UI for schema creation (no code)

---

## Conclusion

The `register_schema` tool is now fully functional and matches the capabilities of the Python SDK. Agents can create complete, production-ready schemas with entity types, relationships, and validation rules in a single tool call.

**Key Takeaway:** Always pass `node_types` and `relationship_types` when calling `register_schema` - otherwise you'll get an empty shell schema.
