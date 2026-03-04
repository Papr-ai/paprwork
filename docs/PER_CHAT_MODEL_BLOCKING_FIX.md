# Per-Chat Model Download Blocking Fix

**Issue:** When downloading a Qwen model, ALL chats were blocked globally, preventing users from using other chats with different models.

**Root Cause:** The `preparingModel` state was blocking the entire chat container regardless of which chat was active or which model was selected.

## ✅ Solution: Per-Chat Blocking

### What Changed

**Before (Global Blocking):**
```tsx
const [preparingModel, setPreparingModel] = useState(false);

// Blocks ALL chats
isSending={isSending || preparingModel}
```

**After (Per-Chat Blocking):**
```tsx
const { installing } = useOllama(); // Tracks which model ID is downloading

// Only blocks THIS chat if waiting for its selected Ollama model
const isWaitingForModel = selectedModel.provider === 'ollama' && installing === selectedModel.id;

// Only blocks if this specific chat is waiting
isSending={isSending || isWaitingForModel}
placeholder={isWaitingForModel ? `Preparing ${selectedModel.name}...` : "Type a message..."}
```

### How It Works

1. **Global Download Tracking:** `installing` state in `useOllama` hook tracks which model ID is currently downloading (e.g., "qwen3.5:2b")

2. **Per-Chat Check:** Each chat compares its `selectedModel.id` with the `installing` model:
   ```tsx
   isWaitingForModel = (my model is Ollama) && (my model is the one downloading)
   ```

3. **Independent Chats:** Other chats with different models are not affected

### User Experience

**Scenario: User selects Qwen 3.5 9B in Chat A**

| Action | Chat A (Qwen 9B) | Chat B (Claude) | Chat C (GPT-5) |
|--------|------------------|-----------------|----------------|
| Download starts | 🔒 Blocked | ✅ Available | ✅ Available |
| 50% progress | 🔒 Blocked | ✅ Available | ✅ Available |
| Download complete | ✅ Available | ✅ Available | ✅ Available |

**Users can:**
- ✅ Switch to Chat B and use Claude while Qwen downloads
- ✅ Switch to Chat C and use GPT-5 while Qwen downloads
- ✅ Create new chats with any model
- ✅ Only Chat A (waiting for Qwen) is blocked

### Benefits

1. **Non-Blocking:** Users aren't stuck waiting - can work in other chats
2. **Multi-Model Workflow:** Download Qwen in background while using cloud models
3. **Better UX:** No artificial limitations on chat usage
4. **Progress Visible:** Progress banner shows globally, but only blocks relevant chat

### Technical Details

**Chat Identification:**
- Each chat has unique `chatId`
- Each chat remembers its `selectedModel` independently
- Model selection is persisted per-chat in localStorage

**Download State:**
- Global `installing` state: Which model is downloading
- Global `progress` state: Download percentage
- Per-chat `isWaitingForModel`: Only true for chats using that model

**Input Blocking:**
```tsx
// Only blocks if:
// 1. This chat selected an Ollama model
// 2. That specific Ollama model is currently downloading
const isWaitingForModel = 
  selectedModel.provider === 'ollama' && 
  installing === selectedModel.id;
```

### Edge Cases Handled

1. **Multiple chats with same model:** All chats waiting for "qwen3.5:2b" are blocked, others aren't
2. **Model already downloaded:** `installing` is null, no chats blocked
3. **Switch model mid-download:** If user switches from Qwen to Claude in Chat A, Chat A becomes available immediately
4. **Download completes:** `installing` becomes null, all chats unblocked

### Code Changes

**File:** `ui/components/Chat/ChatContainer.tsx`

**Changes:**
1. Removed local `preparingModel` state
2. Added `installing` from `useOllama` hook
3. Computed `isWaitingForModel` per-chat
4. Updated placeholder text to show model name
5. Removed `setPreparingModel` calls

**Result:** ✅ Each chat is independent, download doesn't block unrelated chats

---

## Testing

**Test Case 1: Single Chat**
1. Select Qwen 3.5 2B in Chat 1
2. Chat 1 shows "Preparing Qwen 3.5 2B..."
3. Input disabled in Chat 1
✅ Expected: Works as before

**Test Case 2: Multiple Chats, Same Model**
1. Chat 1: Select Qwen 3.5 2B
2. Chat 2: Select Qwen 3.5 2B
3. Chat 3: Select Claude
✅ Expected: Chat 1 & 2 blocked, Chat 3 available

**Test Case 3: Multiple Chats, Different Models**
1. Chat 1: Select Qwen 3.5 9B (starts download)
2. Switch to Chat 2: Select Claude
3. Use Chat 2 while download continues
✅ Expected: Chat 2 works normally, Chat 1 blocked

**Test Case 4: Switch Model Mid-Download**
1. Chat 1: Select Qwen 3.5 2B (starts download)
2. Chat 1: Switch to Claude
3. Chat 1 should immediately become available
✅ Expected: Chat 1 unblocked, can use Claude

**Test Case 5: Download Completes**
1. Chat 1: Select Qwen 3.5 2B
2. Wait for download to complete
3. Progress banner disappears
4. Chat 1 becomes available with Qwen model
✅ Expected: Chat 1 ready to use

---

## Summary

**Problem:** Global blocking prevented multi-chat usage during downloads

**Solution:** Per-chat blocking based on model selection

**Impact:** Much better UX - users can work in other chats while models download

**Implementation:** Simple conditional check comparing chat's model with downloading model
