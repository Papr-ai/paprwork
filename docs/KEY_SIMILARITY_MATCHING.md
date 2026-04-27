# Key Similarity Matching & LLM Provider Handling

**Added:** 2026-04-24
**Status:** ✅ IMPLEMENTED

## Problem

When importing community apps, the import wizard was requesting API keys even when users already had similar keys configured with slightly different names. For example:

- App wants `VERCEL_API_KEY` but user has `VERCEL_KEY` → wizard says "Not configured"
- App wants `ANTHROPIC_API_KEY` but user can use OAuth or Papr proxy → wizard says "required"

This created confusion and made users think they needed to configure duplicate keys.

## Solution

Implemented three key improvements:

### 1. Fuzzy/Similarity Key Matching

Created `/src/core/utils/keySimilarity.ts` with intelligent key name matching:

- **Exact match** (100% score) - Already configured
- **Same service name** (90% score) - `VERCEL` matches `VERCEL_API_KEY` vs `VERCEL_KEY`
- **Normalized match** (95% score) - `VERCEL_APIKEY` vs `VERCEL_API_KEY`
- **Substring match** (80% score) - One contains the other
- **Levenshtein distance** (60-100% score) - Edit distance similarity

### 2. Similar Key Selection UI

Enhanced `ImportSetupWizard` to show similar keys when a requested key isn't found:

```tsx
{currentEntry.similarKeys && currentEntry.similarKeys.length > 0 && (
  <div className="isw-similar-keys">
    <div className="isw-similar-keys__header">
      <strong>You already have similar keys:</strong>
    </div>
    <div className="isw-similar-keys__list">
      {currentEntry.similarKeys.map((similar) => (
        <button
          className="isw-similar-key-btn"
          onClick={() => selectKey(similar.name)}
        >
          <div className="isw-similar-key-btn__name">{similar.name}</div>
          <div className="isw-similar-key-btn__reason">{similar.reason}</div>
        </button>
      ))}
    </div>
    <div className="isw-similar-keys__footer">
      <span className="isw-similar-keys__note">
        Select an existing key to use instead of creating a new one
      </span>
    </div>
  </div>
)}
```

**User Experience:**
- User sees all similar keys with similarity scores
- Click to select existing key instead of creating duplicate
- Clear visual feedback (checkmark on selected key)
- Green success styling to indicate "this solves the problem"

### 3. LLM Provider Keys Marked Optional

Created `isOptionalLLMKey()` function that recognizes common LLM provider keys:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_AI_API_KEY`
- `GOOGLE_GEMINI_API_KEY`

These keys are now marked as "Optional (OAuth/Papr)" because users can:
1. Use OAuth authentication (ChatGPT Plus/Pro, Claude Pro/Max)
2. Use Papr's proxy for free API access
3. Skip entirely if the app feature is optional

## Implementation Details

### Key Similarity Algorithm

```typescript
export function findSimilarKeys(
  requestedKey: string,
  existingKeys: string[],
  threshold = 0.6
): SimilarKey[] {
  // 1. Normalize both keys (lowercase, remove underscores)
  const requestedNorm = normalizeKeyName(requestedKey);
  
  // 2. Extract service name (e.g., "VERCEL" from "VERCEL_API_KEY")
  const requestedService = extractServiceName(requestedKey);
  
  // 3. Check each existing key for similarity
  for (const existingKey of existingKeys) {
    // Same service? High score
    if (requestedService === extractServiceName(existingKey)) {
      return { score: 0.9, reason: "Same service: VERCEL" };
    }
    
    // Levenshtein distance? Calculate similarity
    const distance = levenshteinDistance(requestedNorm, existingNorm);
    const similarity = 1 - distance / maxLength;
    
    if (similarity >= threshold) {
      return { score: similarity, reason: "85% similar" };
    }
  }
  
  // Sort by score (highest first)
  return results.sort((a, b) => b.score - a.score);
}
```

### Wizard Integration

Enhanced `loadInitialState()` in `ImportSetupWizard.tsx`:

```typescript
const wizardEntries: WizardEntry[] = enriched.map((spec) => {
  const isConnected = keyNameSet.has(spec.name);
  
  // Check if LLM provider key (can use OAuth/Papr)
  const isLLMKey = isOptionalLLMKey(spec.name);
  
  // Find similar keys if not connected
  let similarKeys: SimilarKey[] = [];
  if (!isConnected && existingKeyNames.length > 0) {
    similarKeys = findSimilarKeys(spec.name, existingKeyNames, 0.6);
  }
  
  // Determine status
  let status: "connected" | "missing" | "optional";
  if (isConnected) {
    status = "connected";
  } else if (isLLMKey || !spec.required) {
    status = "optional"; // LLM keys are optional!
  } else {
    status = "missing";
  }
  
  return { spec, status, similarKeys };
});
```

### Submit Handler Enhancement

Updated `handleKeySubmit()` to handle similar key selection:

```typescript
if (currentEntry.selectedSimilarKey) {
  // User selected an existing key - map it to requested key name
  setEntries((prev) =>
    prev.map((e) =>
      e === currentEntry
        ? {
            ...e,
            status: "connected",
            substitution: {
              originalService: e.spec.service,
              chosenService: e.spec.service,
              chosenKeyName: e.selectedSimilarKey!,
              keyValue: "", // Already stored
            },
          }
        : e
    )
  );
}
```

**Key Insight:** When user selects a similar key, we create a "substitution" entry that tells the agent:
> "Use `VERCEL_KEY` (existing) instead of `VERCEL_API_KEY` (requested)"

The agent then adapts the import to use the existing key name.

## UI/UX Details

### Similar Keys Section

**Visual Design:**
- Green accent color (success/solution theme)
- Frosted glass cards with hover effects
- Checkmark on selected key
- Similarity score displayed ("Same service: VERCEL", "85% similar")

**Interaction:**
- Click any similar key to select it
- Selected key gets green highlight + checkmark
- Submit button enabled when key selected
- No need to paste a new API key

### Optional Badge Enhancement

**Before:** `Optional`
**After:** `Optional (OAuth/Papr)` for LLM keys

This makes it clear WHY the key is optional — users understand they have alternative authentication methods.

## Agent Message Enhancement

When the agent imports an app with similar key selection, the message includes:

```
The following API keys are already configured in Settings: VERCEL_KEY.

IMPORTANT — Service substitutions requested:
- Replace Vercel (VERCEL_API_KEY) with Vercel (VERCEL_KEY). The key for Vercel 
  is already saved in Settings. Please use ${VERCEL_KEY} instead of ${VERCEL_API_KEY} 
  in the app code.
```

The agent understands the substitution and updates the app code accordingly.

## Files Changed

### Created
- `src/core/utils/keySimilarity.ts` - Similarity matching algorithm

### Modified
- `ui/components/Apps/ImportSetupWizard.tsx` - Added similar keys UI, LLM optional handling, selection logic
- `ui/components/Apps/ImportSetupWizard.css` - Added similar keys section styles (light + dark mode)

## Testing

### Manual Testing Checklist

1. **Similar Key Detection:**
   - [ ] User has `VERCEL_KEY`, app wants `VERCEL_API_KEY` → shows as similar
   - [ ] User has `NEON_DATABASE_URL`, app wants `NEON_DB_URL` → shows as similar
   - [ ] User has `OPENAI_KEY`, app wants `OPENAI_API_KEY` → shows as similar

2. **LLM Key Optional:**
   - [ ] App requests `ANTHROPIC_API_KEY` → shows as "Optional (OAuth/Papr)"
   - [ ] App requests `OPENAI_API_KEY` → shows as "Optional (OAuth/Papr)"
   - [ ] App requests `GOOGLE_AI_API_KEY` → shows as "Optional (OAuth/Papr)"

3. **Similar Key Selection:**
   - [ ] Click similar key → key gets selected (checkmark appears)
   - [ ] Submit button becomes enabled
   - [ ] Agent message includes substitution instructions
   - [ ] App import works with substituted key

4. **Edge Cases:**
   - [ ] No similar keys → section doesn't show
   - [ ] Multiple similar keys → all shown, sorted by score
   - [ ] Already connected → no similar keys section
   - [ ] Skip key → continues to next key

## Impact

- **Before:** Users confused about duplicate keys, created unnecessary API keys, or gave up on import
- **After:** Users see existing keys, select with one click, import succeeds ✅
- **LLM Keys:** Users understand they can use OAuth/Papr, don't need API key ✅
- **User Experience:** Professional, helpful, reduces friction

## Future Enhancements

1. **Smart Defaults:** Auto-select highest-scoring similar key (>90% score)
2. **Key Aliases:** User-defined key aliases ("use MY_VERCEL_KEY for all VERCEL_* requests")
3. **Bulk Operations:** "Use similar keys for all" button
4. **Key Validation:** Check if selected key actually works for the service
5. **Provider Detection:** Detect provider from key format (e.g., Vercel keys start with `vercel_`)

## Pattern for Other Features

This fuzzy matching + selection pattern can be extended to:
- Job creation (suggest similar job names)
- Model selection (suggest similar models)
- Provider selection (suggest similar providers)
- File paths (suggest similar paths for file operations)

**Key Principle:** When asking for something the user already has (but with a slightly different name), ALWAYS suggest the existing items before forcing them to create duplicates.
