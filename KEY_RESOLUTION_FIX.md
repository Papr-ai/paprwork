# Key Resolution Fix

## Issue
OpenAI API key was visible in Settings UI but not found via IPC when Gateway tried to generate chat titles.

## Root Cause
The Electron IPC handler in `src/electron/index.cjs` was using:
```javascript
const value = await customKeysStorage.getKey(keyName);
```

But `getKey()` expects a **UUID** (the key's ID), not the key's name. It should use `getKeyByName()`:
```javascript
const value = await customKeysStorage.getKeyByName(keyName);
```

## What Was Broken
1. **Title Generation**: Failed because Gateway couldn't get OpenAI key
   - Log showed: `[AgentService] No title service available, using fallback`
   - Tabs showed truncated user message instead of AI-generated title

2. **Key Resolution Timeout**: 7-second delay on first message
   - Log showed: `[KeyResolver] Failed to resolve keys via IPC: Error: Key resolution timeout`
   - Gateway waited 7 seconds for IPC response before timing out

## What Still Worked
- **Chat streaming**: UI gets keys directly from Electron (`window.electronAPI.customKeys.getByName`)
- **Settings UI**: Displays keys correctly using the same direct Electron API

## Fix
Changed line 113 in `src/electron/index.cjs`:
```diff
- const value = await customKeysStorage.getKey(keyName);
+ const value = await customKeysStorage.getKeyByName(keyName);
```

## Expected Behavior After Fix
1. ✅ Chat titles will be AI-generated (not truncated user messages)
2. ✅ No 7-second delay on first message
3. ✅ Gateway logs will show: `[Electron]   ✓ Resolved OPENAI_API_KEY`
4. ✅ Title service will be available: `[AgentService] Title service ready`

## Testing
1. Stop the app (`Ctrl+C`)
2. Rebuild: `npm run build`
3. Start: `npm start`
4. Create a new chat
5. Send a message
6. Check:
   - Title appears quickly in tab (AI-generated, not truncated message)
   - No "Key resolution timeout" errors
   - First message streams without 7-second delay

## Related Files
- `src/electron/index.cjs` (line 113) - IPC key resolver
- `src/gateway/utils/keyResolver.ts` - Gateway-side key resolution
- `src/electron/services/CustomKeysStorage.ts` - Key storage API
