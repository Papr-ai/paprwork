# Testing Papr SDK v2.4.0 Update

## ✅ Quick Verification (No API Key Required)

First, verify that all tools and parameters are correctly implemented:

```bash
npm run verify:papr-tools
```

**Expected Result:** All 40 checks should pass ✅

This verifies:
- All 11 tools are exported (8 existing + 3 new)
- Holographic parameters added to `add_agent_memory` (2 new params)
- Holographic config added to `search_agent_memory` (9 params)
- New tools have correct structure (`delete_memory`, `delete_schema`, `create_entities`)

---

## 🧪 Full Integration Tests (API Key Required)

To test actual SDK functionality with API calls:

### Step 1: Set Your API Key

**Option A: In Paprwork (Recommended)**
1. Open Paprwork
2. Go to Settings → API Keys
3. Add your `PAPR_API_KEY`

**Option B: Environment Variable**
```bash
export PAPR_API_KEY="sk-org-xxx-namespace-xxx-xxxxxxxxxx"
```

Get your API key at: https://dashboard.papr.ai

### Step 2: Run Integration Tests

```bash
npm run test:papr-sdk
```

This comprehensive test suite will:

1. **Test SDK Version** - Verify v2.4.0 is installed
2. **Test Holographic Add** - Create memories with `enable_holographic: true`
3. **Test Holographic Search** - Search with frequency filters and scores
4. **Test Memory Deletion** - Delete memories by ID
5. **Test Manual Entity Creation** - Create exact entities/relationships
6. **Test Schema Deletion** - Soft-delete (archive) schemas

**Expected Result:** All tests pass with automatic cleanup ✅

---

## 📊 Test Results

### Verification Results (Just Completed)

```
Total Checks: 40
✓ Passed: 40
✗ Failed: 0
Pass Rate: 100.0%

🎉 ALL CHECKS PASSED!
```

### What Was Verified

✅ **Tool Exports (11 tools)**
- add_agent_memory, search_agent_memory
- register_schema, update_schema, list_schemas, get_schema
- introspect_memory_graph, query_memory_graph
- **NEW:** delete_memory, delete_schema, create_entities

✅ **Holographic Parameters (11 new parameters total)**
- `add_agent_memory`: enableHolographic, frequencySchemaId
- `search_agent_memory`: holographicConfig object with 9 fields
  - enabled, frequencySchemaId, searchMode, scoringMethod
  - includeFrequencyScores, frequencyFilters
  - hcondBoostFactor, hcondBoostThreshold, hcondPenaltyFactor

✅ **Tool Structure**
- All tools have correct input schemas
- All descriptions are accurate
- All parameters are properly typed

✅ **Registry Integration**
- Tools exported in paprMemoryTools array
- Tools available in allTools
- Tools categorized in toolsByCategory.papr

---

## 🎯 Manual Testing in Paprwork

Once the full test suite passes, you can test features directly in Paprwork:

### Test Holographic Search

```
Ask the agent:
"Search my memories about machine learning with holographic frequency scoring enabled"

The agent will use:
search_agent_memory({
  query: "machine learning",
  holographicConfig: {
    enabled: true,
    includeFrequencyScores: true
  }
})
```

### Test Memory Deletion

```
Ask the agent:
"Delete the memory with ID mem_abc123"

The agent will use:
delete_memory({ memoryId: "mem_abc123" })
```

### Test Entity Creation

```
Ask the agent:
"Create a Company entity named Papr AI and a Product entity named Papr Memory SDK, with a DEVELOPS relationship between them"

The agent will use:
create_entities({
  content: "Company and product relationship",
  nodes: [...],
  relationships: [...]
})
```

---

## 📚 Documentation

- **Full Test Guide:** `docs/PAPR_SDK_TEST_GUIDE.md`
- **Implementation Plan:** `.cursor/plans/papr_sdk_update_5ab6c4b5.plan.md`
- **SystemPrompt Updates:** Search for "Holographic" in `src/core/agents/SystemPrompt.ts`

---

## ⚠️ Troubleshooting

### "PAPR_API_KEY not set"
- Set in Paprwork Settings → API Keys, or
- Export environment variable: `export PAPR_API_KEY="your-key"`

### Tests fail with "Authentication Error"
- Check your API key is valid at https://dashboard.papr.ai
- Regenerate if needed

### "Quota Exceeded"
- Upgrade your Papr account, or
- Wait for monthly quota reset

### Holographic tests return errors
- Use `"default"` as frequencySchemaId
- Check available schemas at https://docs.papr.ai

---

## ✨ What's New

### SDK v2.4.0 Features

1. **Holographic Neural Transforms**
   - 13 brain-inspired frequency bands for semantic encoding
   - Per-dimension score breakdown
   - Filter by semantic alignment thresholds

2. **Memory Management**
   - Delete individual memories
   - Clean up old/incorrect data

3. **Schema Management**
   - Soft-delete (archive) schemas
   - Restore archived schemas

4. **Manual Graph Generation**
   - Create exact entities and relationships
   - Full control over graph structure
   - Perfect for API integrations

### Tool Enhancements

- **add_agent_memory:** +2 parameters (enableHolographic, frequencySchemaId)
- **search_agent_memory:** +1 object with 9 fields (holographicConfig)
- **3 New Tools:** delete_memory, delete_schema, create_entities

---

## 🚀 Next Steps

1. ✅ Verification passed (40/40 checks)
2. ⏳ Set PAPR_API_KEY
3. ⏳ Run `npm run test:papr-sdk`
4. ⏳ Test features in Paprwork

Once all tests pass, you're ready to use all new SDK features in production! 🎉
