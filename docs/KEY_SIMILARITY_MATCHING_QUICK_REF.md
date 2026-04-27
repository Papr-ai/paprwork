# Key Similarity Matching - Quick Reference

## Problem Solved

Import wizard asking for keys users already have with slightly different names.

## Solution

Three features working together:

### 1. Fuzzy Matching
- Finds similar key names (VERCEL_KEY ≈ VERCEL_API_KEY)
- Shows similarity score
- User clicks to select existing key

### 2. LLM Keys Optional
- `OPENAI_API_KEY` → Optional (OAuth/Papr)
- `ANTHROPIC_API_KEY` → Optional (OAuth/Papr)
- `GOOGLE_AI_API_KEY` → Optional (OAuth/Papr)

### 3. Smart Substitution
- Agent adapts app code to use selected key
- No duplicate keys created
- Import works seamlessly

## User Flow

```
1. User clicks "Import App"
   ↓
2. Wizard checks required keys
   ↓
3. Key not exact match? Search for similar keys
   ↓
4. Show similar keys with scores
   ("Same service: VERCEL", "85% similar")
   ↓
5. User clicks existing key
   ↓
6. Submit → Agent adapts app code
   ↓
7. Import succeeds with existing key ✅
```

## Similarity Scores

- **100%** - Exact match (already connected)
- **95%** - Same key, different formatting (VERCEL_APIKEY vs VERCEL_API_KEY)
- **90%** - Same service name (VERCEL matches both)
- **80%** - Substring match (one contains other)
- **60-100%** - Edit distance (Levenshtein)

## Example Matches

| Requested Key | User Has | Match Type | Score |
|---------------|----------|------------|-------|
| VERCEL_API_KEY | VERCEL_KEY | Same service | 90% |
| NEON_DB_URL | NEON_DATABASE_URL | Substring | 80% |
| OPENAI_API_KEY | OPENAI_KEY | Same service | 90% |
| ANTHROPIC_API_KEY | ANTHROPIC_KEY | Same service | 90% |
| STRIPE_API_KEY | STRIPE_SECRET_KEY | Substring | 80% |

## Files Changed

- `src/core/utils/keySimilarity.ts` - Algorithm
- `ui/components/Apps/ImportSetupWizard.tsx` - UI + logic
- `ui/components/Apps/ImportSetupWizard.css` - Styles
- `docs/KEY_SIMILARITY_MATCHING.md` - Full docs

## Testing

```bash
# Start app
npm start

# Try importing an app that needs keys you have with different names
# Example: App wants VERCEL_API_KEY, you have VERCEL_KEY

# Expected: Similar keys section appears
# Click existing key → Submit → Import succeeds
```

## Agent Message Format

When substitution happens:

```
IMPORTANT — Service substitutions requested:
- Replace Vercel (VERCEL_API_KEY) with Vercel (VERCEL_KEY).
  The key for Vercel is already saved in Settings.
  Please use ${VERCEL_KEY} instead of ${VERCEL_API_KEY} in the app code.
```

Agent adapts the code automatically.

## Key Functions

```typescript
// Find similar keys
findSimilarKeys(
  requestedKey: "VERCEL_API_KEY",
  existingKeys: ["VERCEL_KEY", "STRIPE_KEY"],
  threshold: 0.6
)
// Returns: [{ name: "VERCEL_KEY", score: 0.9, reason: "Same service: VERCEL" }]

// Check if LLM provider key
isOptionalLLMKey("ANTHROPIC_API_KEY")
// Returns: true (can use OAuth/Papr)
```

## CSS Classes

- `.isw-similar-keys` - Container
- `.isw-similar-key-btn` - Key button
- `.isw-similar-key-btn--selected` - Selected state
- `.isw-similar-key-btn__name` - Key name (monospace)
- `.isw-similar-key-btn__reason` - Similarity reason
- `.isw-similar-key-btn__check` - Checkmark (✓)

## Future Enhancements

1. Auto-select highest score (>90%)
2. User-defined key aliases
3. "Use similar for all" button
4. Key format validation
5. Provider detection from key format
