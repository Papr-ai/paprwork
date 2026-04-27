# Telemetry Anonymous ID Mismatch Fix

**Date:** 2026-04-22  
**Issue:** 403 Forbidden - "anonymous_id mismatch" when renderer sends telemetry events

## Problem

The renderer was getting a 403 error when trying to send telemetry events:

```
POST http://localhost:18789/api/telemetry/events 403 (Forbidden)
[Telemetry] Renderer POST failed: 403 {"error":"anonymous_id mismatch"}
```

## Root Cause

There were **two separate settings storage systems** operating independently:

1. **Electron Main Process** - Uses `electron-store` (via `SettingsStorage.ts`)
   - Location: `~/Library/Application Support/Papr Work/config.json` (macOS)
   - Creates and stores `telemetry.installId`
   - Passes to Gateway via `PAPRWORK_TELEMETRY_ANONYMOUS_ID` env var

2. **Gateway WebSocket Handler** - Used custom JSON file (via `settings.ts`)
   - Location: `~/Papr/data/settings.json`
   - **Did NOT include telemetry data**
   - Renderer read from this file when calling `settings:get`

### The Mismatch

1. Main process creates `installId` in electron-store → sends to Gateway as env var
2. Renderer requests settings via `settings:get` WebSocket
3. Gateway returned data from `~/Papr/data/settings.json` (no telemetry data!)
4. Renderer used empty or default installId from Gateway's file
5. Gateway validation checked against env var from main process
6. **Mismatch!** → 403 Forbidden

## Solution

Modified Gateway's `settings:get` handler to include telemetry data from environment variables:

```typescript
// Gateway's loadSettings() now includes telemetry from env vars
export async function loadSettings(): Promise<SettingsData> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    const saved = JSON.parse(raw) as Partial<SettingsData>;
    const settings = {
      ...DEFAULTS,
      ...saved,
      preferences: { ...DEFAULTS.preferences, ...saved.preferences },
    };
    
    // Add telemetry data from environment variables (set by main process)
    // This ensures consistency with the main process's electron-store
    const installId = process.env.PAPRWORK_TELEMETRY_ANONYMOUS_ID?.trim() || "";
    const enabled = process.env.PAPRWORK_TELEMETRY_ENABLED === "true";
    
    if (installId) {
      settings.telemetry = {
        installId,
        enabled,
      };
    }
    
    return settings;
  } catch {
    // ...
  }
}
```

## Impact

- **Before:** Renderer and Gateway used different installIds → 403 errors
- **After:** Both use the same installId from electron-store → telemetry works ✅

## Files Changed

- `src/gateway/websocket/settings.ts` - Added telemetry data from env vars to settings response

## Testing

1. Start app in development mode: `npm start`
2. Open DevTools console
3. Trigger any telemetry event (e.g., open settings, create chat)
4. Verify no 403 errors in console
5. Verify telemetry events are sent successfully

## Related Issues

- Enhancement 41: Amplitude Enhanced Event Tracking
- Issue similar to Windows smartscreen (different storage locations causing issues)

## Key Takeaway

When you have multiple processes (Main, Gateway, Renderer), ensure they all read from a **single source of truth** for critical configuration like telemetry IDs. In this case:

- Main process owns the source of truth (electron-store)
- Main process passes data to Gateway via env vars
- Gateway includes env var data in WebSocket responses
- Renderer uses data from Gateway (which came from Main)

This creates a consistent data flow: **Main → Gateway → Renderer**
