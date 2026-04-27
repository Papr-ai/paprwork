# GPT-5.4 → GPT-5.5 Replacement

**Updated:** 2026-04-24

## Summary

Replaced all GPT-5.4 reasoning variants with GPT-5.5 equivalents in the model picker, keeping only GPT-5.4-mini as the distinct smaller model.

## Changes Made

### Model Lineup

**Before:**
- gpt-5.4-mini
- gpt-5.4-low
- gpt-5.4 (medium)
- gpt-5.4-high
- gpt-5.3-codex
- gpt-5.5 (medium)
- gpt-5.5-pro

**After:**
- gpt-5.4-mini (kept - distinct mini model)
- gpt-5.5-low
- gpt-5.5 (medium, recommended)
- gpt-5.5-high
- gpt-5.5-pro
- gpt-5.3-codex

### Reasoning Effort Variants

All GPT-5.5 variants use the same base pricing ($5/$30 per 1M tokens):
- `gpt-5.5-low` - Faster, lighter reasoning
- `gpt-5.5` - Balanced reasoning (default, recommended)
- `gpt-5.5-high` - Deeper reasoning
- `gpt-5.5-xhigh` - Maximum reasoning effort (not in picker, but supported via API)
- `gpt-5.5-pro` - Highest accuracy (6x cost: $30/$180)

### Price Changes

| Model | Old Price | New Price | Change |
|-------|-----------|-----------|--------|
| gpt-5.4-low/med/high | $2.50 / $15 | $5 / $30 | **2x more expensive** |
| gpt-5.4-mini | $0.75 / $4.50 | $0.75 / $4.50 | No change |
| gpt-5.3-codex | $15 / $45 | $15 / $45 | No change |

**Claude comparison:**
- Claude Opus 4.6: $15 / $75 → **3x more expensive than GPT-5.5**
- Claude Opus 4.7: $5 / $25 → **Same input, cheaper output than GPT-5.5**

### Context Window Improvements

| Model | Context | Threshold in Paprwork | Tool Calls Before Compression |
|-------|---------|----------------------|-------------------------------|
| GPT-5.4 | 272K | 200K | ~20-30 |
| GPT-5.5 | 1M | 750K | **~75-100** (3.75x improvement) |
| GPT-5.4-mini | 272K | 200K | ~20-30 |

### Legacy Model Handling

**Forward compatibility:** All legacy GPT-5.4 references now map to GPT-5.5:
- Cost calculation: `gpt-5.4` → uses GPT-5.5 pricing ($5/$30)
- Model normalizer: `gpt-5.4-low/high` → maps to `gpt-5.5` API
- Context thresholds: `gpt-5.4` → uses 750K threshold (1M context)
- OAuth support: `gpt-5.4-*` → supported via ChatGPT Plus/Pro

**Exception:** `gpt-5.4-mini` stays as-is (distinct smaller model with 272K context).

### Files Updated

1. **`ui/constants/models.ts`**
   - Replaced 3 GPT-5.4 variants with GPT-5.5 variants
   - Updated default model preferences
   - Kept gpt-5.4-mini unchanged

2. **`src/gateway/services/CostCalculation.ts`**
   - Added pricing for gpt-5.5-low, gpt-5.5, gpt-5.5-high, gpt-5.5-xhigh
   - Updated legacy gpt-5.4 pricing to forward-compatible GPT-5.5 tier
   - Kept gpt-5.4-mini pricing unchanged

3. **`src/gateway/utils/modelNormalizer.ts`**
   - Updated normalization: gpt-5.4 variants → gpt-5.5
   - Added GPT-5.5 reasoning suffix stripping
   - Updated OAuth model detection
   - Exception: gpt-5.4-mini stays as-is

4. **`src/gateway/services/AgentService.ts`**
   - Updated default model: `openai: "gpt-5.5"`
   - Updated context threshold logic for legacy 5.4 → 750K
   - Updated manual pi-ai registry creation for GPT-5.5

5. **`src/gateway/services/providers/PiCodexStreamWithToolLoop.ts`**
   - Updated context threshold: gpt-5.4 non-mini → 750K
   - Kept gpt-5.4-mini at 200K

6. **`src/gateway/utils/defaultProvider.ts`**
   - Updated default: `openai: "gpt-5.5"`
   - Updated comments and docs

7. **`src/gateway/services/jobs/executors/AgentJobExecutor.ts`**
   - Updated default model reference in logs

## User Impact

### Benefits
- ✅ **3.75x larger context** (1M vs 272K for GPT-5.4)
- ✅ **Better agentic performance** (first fully retrained model since GPT-4.5)
- ✅ **Cleaner model picker** (no 5.4 vs 5.5 confusion)
- ✅ **Forward compatible** (old chats with 5.4 work seamlessly)

### Considerations
- ⚠️ **2x price increase** ($5/$30 vs $2.50/$15)
- ⚠️ **Same reasoning effort names** but different implementation
- ℹ️ **5.4-mini unchanged** for budget-conscious users

## Migration Path

**No action needed!** 
- Existing chats with GPT-5.4 automatically use GPT-5.5 pricing and features
- Saved preferences automatically upgrade
- Model normalizer handles all legacy references

## Testing

Verify the following work correctly:
1. ✅ Model picker shows GPT-5.5 variants (not 5.4)
2. ✅ Cost calculation shows $5/$30 for GPT-5.5
3. ✅ Legacy chats with gpt-5.4 work without errors
4. ✅ OAuth routing works for gpt-5.5 variants
5. ✅ Context threshold is 750K for GPT-5.5
6. ✅ gpt-5.4-mini stays at $0.75/$4.50

## Related

- `docs/GPT_5_5_AND_CLAUDE_OPUS_4_7_ADDITION.md` - Original addition
- `docs/NEW_MODELS_QUICK_REFERENCE.md` - Quick reference guide
- Issue 17: GPT-5.4 Context Limit Fix (context-aware thresholds)
