# Papr SDK v2.4.0 Testing Guide

This guide explains how to test the new Papr SDK v2.4.0 features and tool enhancements.

## What's New in v2.4.0

### 1. Holographic Neural Transforms
- **Frequency-based semantic encoding** using 13 brain-inspired frequency bands
- **Per-dimension score breakdown** to understand WHY results ranked high/low
- **Frequency filters** to filter results by minimum alignment thresholds

### 2. Memory Management
- **Delete individual memories** with `delete_memory` tool
- Proper cleanup capabilities for old/incorrect data

### 3. Schema Management
- **Soft-delete (archive) schemas** with `delete_schema` tool
- Schemas can be restored by updating status to 'active'

### 4. Manual Graph Generation
- **Create exact entities and relationships** with `create_entities` tool
- Perfect for structured data imports and API integrations
- Full control over node IDs, properties, and relationships

## Running the Test Suite

### Prerequisites

1. **Papr API Key**: You need a valid Papr API key
   - Get one at: https://dashboard.papr.ai
   - Set in Settings → API Keys in Paprwork, OR
   - Export as environment variable: `export PAPR_API_KEY="your-key-here"`

2. **Node.js v24+**: Ensure you're using the correct Node version
   ```bash
   nvm use 24
   ```

### Quick Test

Run the comprehensive test suite:

```bash
# From project root
npm run test:papr-sdk

# Or directly
node scripts/test-papr-sdk-update.mjs
```

### What the Test Suite Covers

The test suite runs **6 test categories** with **15+ individual tests**:

#### Test 1: SDK Version Verification
- ✓ Confirms SDK is v2.4.0
- ✓ Verifies client initialization

#### Test 2: Holographic Parameters in `add_agent_memory`
- ✓ Standard memory addition (baseline)
- ✓ Memory with `enable_holographic: true`
- ✓ Memory with `frequency_schema_id` specified
- ✓ Validates holographic encoding

#### Test 3: Holographic Config in `search_agent_memory`
- ✓ Standard search (baseline)
- ✓ Search with `holographic_config.enabled`
- ✓ Search with `include_frequency_scores: true`
- ✓ Search with `frequency_filters` by dimension
- ✓ Validates frequency score data in results

#### Test 4: Memory Deletion
- ✓ Creates test memory
- ✓ Deletes memory using `client.memory.delete()`
- ✓ Verifies memory is removed from search results

#### Test 5: Manual Entity Creation
- ✓ Creates entities with exact specifications
- ✓ Creates relationships between entities
- ✓ Uses `memory_policy: { mode: 'manual' }`
- ✓ Verifies entities are searchable

#### Test 6: Schema Deletion (Soft Delete)
- ✓ Creates test schema
- ✓ Soft-deletes (archives) schema
- ✓ Verifies schema status is 'archived'

### Expected Output

```
🧪 Papr SDK v2.4.0 Test Suite
Testing new features and enhancements

============================================================
TEST 1: SDK Version Verification
============================================================
Current SDK version: ^2.4.0
  ✓ SDK version is 2.4.0
  ✓ Papr client initializes correctly

============================================================
TEST 2: Holographic Parameters in add_agent_memory
============================================================
  Testing standard memory add...
  ✓ Add memory without holographic
  Testing holographic memory add...
  ✓ Add memory with holographic enabled
  ✓ Holographic memory created successfully

[... more tests ...]

============================================================
TEST SUMMARY
============================================================

Total Tests: 15
✓ Passed: 15
✗ Failed: 0
Pass Rate: 100.0%

============================================================
🎉 ALL TESTS PASSED!
Papr SDK v2.4.0 update is working correctly.
============================================================
```

## Manual Testing

If you prefer to test manually, here are the key scenarios:

### 1. Test Holographic Add

```typescript
// In Paprwork chat, use the agent:
add_agent_memory({
  content: "Neural encoding test - machine learning optimization techniques",
  enableHolographic: true,
  frequencySchemaId: "default",
  category: "fact"
})
```

### 2. Test Holographic Search

```typescript
search_agent_memory({
  query: "machine learning optimization",
  holographicConfig: {
    enabled: true,
    frequencySchemaId: "default",
    searchMode: "integrated",
    includeFrequencyScores: true,
    frequencyFilters: {
      "primary_topic": 0.7
    }
  }
})
```

### 3. Test Memory Deletion

```typescript
// First, create a test memory and note its ID
add_agent_memory({
  content: "Test memory for deletion",
  category: "fact"
})

// Then delete it
delete_memory({
  memoryId: "mem_abc123" // Use actual ID from above
})
```

### 4. Test Schema Deletion

```typescript
// First, create a test schema and note its ID
register_schema({
  name: "Test Schema",
  description: "For testing deletion",
  status: "draft"
})

// Then soft-delete it
delete_schema({
  schemaId: "schema_xyz789" // Use actual ID from above
})
```

### 5. Test Manual Entity Creation

```typescript
create_entities({
  content: "Company and product relationship data",
  nodes: [
    {
      id: "company_1",
      label: "Company",
      properties: { name: "Acme Corp", industry: "Tech" }
    },
    {
      id: "product_1",
      label: "Product",
      properties: { name: "Widget Pro", version: "2.0" }
    }
  ],
  relationships: [
    {
      sourceNodeId: "company_1",
      targetNodeId: "product_1",
      relationshipType: "DEVELOPS",
      properties: { since: "2024" }
    }
  ]
})
```

## Troubleshooting

### Test Fails: "PAPR_API_KEY not set"

**Solution:** Export your API key:
```bash
export PAPR_API_KEY="sk-org-xxx-namespace-xxx-xxxxxxxxxx"
```

Or set it in Paprwork Settings → API Keys.

### Test Fails: "Authentication Error"

**Problem:** Invalid or expired API key

**Solution:** 
1. Get a new API key from https://dashboard.papr.ai
2. Update in Settings or environment variable

### Test Fails: "Quota Exceeded"

**Problem:** Free tier limits reached

**Solution:**
- Upgrade your Papr account at https://dashboard.papr.ai/settings
- Or wait for quota to reset (monthly)

### Holographic Tests Return Null

**Problem:** Frequency schema doesn't exist or is invalid

**Solution:**
- Use `"default"` as frequency_schema_id for testing
- Or call `GET /v1/frequencies` to list available schemas

### Schema Deletion Fails

**Problem:** Schema might have active dependencies

**Solution:**
- Check if memories are using this schema
- Soft-delete archives but preserves data
- Schema can be restored with `update_schema({ status: "active" })`

## Continuous Integration

To run these tests in CI:

```yaml
# .github/workflows/test.yml
- name: Test Papr SDK
  env:
    PAPR_API_KEY: ${{ secrets.PAPR_API_KEY }}
  run: npm run test:papr-sdk
```

## Next Steps

Once all tests pass:

1. ✅ SDK is correctly updated to v2.4.0
2. ✅ All new tools are working
3. ✅ Holographic features are functional
4. ✅ Ready for production use

You can now use all new features in your workflows!

## Support

- **Documentation:** https://docs.papr.ai
- **API Reference:** https://docs.papr.ai/api
- **Dashboard:** https://dashboard.papr.ai
- **Issues:** Create an issue in the Paprwork repo
