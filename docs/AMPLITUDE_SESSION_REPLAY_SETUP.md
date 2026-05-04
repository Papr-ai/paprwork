# Amplitude Session Replay Setup Guide

## Overview

Paprwork now includes **Amplitude Analytics with Session Replay** to help understand user behavior, debug issues, and improve the product experience.

## What Was Changed

### 1. User Identification Fixed ✅
- **Before**: Events were sent with user_id in properties, but Amplitude treated all users as anonymous
- **After**: Using official Amplitude SDK with proper `setUserId()` and `identify()` calls
- **Result**: Papr user IDs now show up correctly in Amplitude (no longer anonymous)

### 2. Session Replay Enabled ✅
- **Before**: Events-only tracking (no visual recordings)
- **After**: Full session replay with privacy masking
- **Result**: Can watch session recordings to understand user behavior and debug issues

### 3. Privacy Masking Configured ✅
All sensitive data is automatically masked in session replays:
- ✅ API key input fields (`data-sensitive="true"`)
- ✅ Password fields (type="password")
- ✅ Bash/terminal command output
- ✅ Git diff output
- ✅ Email inputs

## Setup Instructions

### 1. Get Your Amplitude API Key

1. Sign up at [amplitude.com/signup](https://amplitude.com/signup)
2. Go to **Settings > Projects** > select your project
3. Copy the **API Key** (not the Secret Key)

### 2. Add Your API Key

You have two options:

#### Option A: Hardcode for Production (Recommended for Packaged Builds)

Edit `ui/lib/telemetry.ts` and replace the placeholder:

```typescript
const AMPLITUDE_API_KEY = 
  import.meta.env.VITE_AMPLITUDE_API_KEY || 
  "a1b2c3d4e5f6g7h8i9j0"; // Your actual Amplitude API key here
```

**Is this safe?** YES! Amplitude client-side API keys are designed to be public:
- ✅ They can only **send** data to Amplitude (not read/export)
- ✅ Every mobile app, website, and Electron app embeds these keys
- ✅ Rate limiting and security are handled by Amplitude's servers
- ✅ This is the same as how Google Analytics, Mixpanel, etc. work

**What gets committed to Git?**
- ✅ The API key in `ui/lib/telemetry.ts` (safe to commit)
- ✅ Downloaded apps will have the key embedded (this is normal)
- ❌ Never commit the **Secret Key** (server-side only)

#### Option B: Development Override (Optional)

For local development, you can override with `.env.local`:

```bash
# Analytics (Optional - overrides hardcoded key in development)
VITE_AMPLITUDE_API_KEY=your_amplitude_api_key_here
```

This is useful if:
- Different developers want to use different Amplitude projects
- You want to test with a separate dev/staging project

### 3. Restart the App

```bash
npm start
```

## How It Works

### Initialization

When the app starts (`ui/App.tsx`):
1. Checks if telemetry is enabled in settings
2. Gets the install ID (anonymous device identifier)
3. Checks if user is logged in to Papr (for identified analytics)
4. Initializes Amplitude with session replay plugin
5. Sets user ID and identifies the user

### Event Tracking

Events are automatically tracked throughout the app using:

```typescript
import { trackEvent } from "./lib/telemetry";

trackEvent("chat_message_sent", {
  message_length: content.length,
  has_attachments: files.length > 0,
});
```

### Session Replay

Session replay captures:
- ✅ UI interactions (clicks, scrolls, navigation)
- ✅ Text input (with masking for sensitive fields)
- ✅ Network requests (sanitized)
- ✅ Console logs (in dev builds only)

Session replay **does NOT** capture:
- ❌ API keys (masked with `data-sensitive="true"`)
- ❌ Passwords (automatically masked)
- ❌ Bash output (marked sensitive)
- ❌ Elements with `class="no-record"` or `data-no-record="true"`

## Privacy Configuration

### Marking Sensitive Data

To mask additional fields in session replay, add the `data-sensitive="true"` attribute:

```tsx
<input
  type="text"
  value={apiKey}
  onChange={(e) => setApiKey(e.target.value)}
  data-sensitive="true"  // This will be masked in session replay
/>
```

### Blocking Elements from Recording

To completely block an element from being recorded:

```tsx
<div className="no-record">
  This content will not appear in session replays
</div>

// Or with data attribute:
<div data-no-record="true">
  This content is also blocked
</div>
```

## Testing

### 1. Verify Initialization

Check browser console logs:

```
[Telemetry] Amplitude initialized with session replay (identified: abc12345…)
```

### 2. Verify Events Are Sent

Open Amplitude dashboard:
1. Go to **User Look-Up**
2. Search for your Papr user ID or install ID
3. Click on a user to see their event stream

### 3. Verify Session Replay

1. Perform some actions in the app (navigate, click, type)
2. Wait 30-60 seconds for replay to sync
3. Go to Amplitude > **Session Replay**
4. Find your session and click to watch

### 4. Verify Privacy Masking

1. Enter an API key in Settings
2. Run a bash command
3. Watch the session replay
4. Verify that:
   - API key fields show `***` or are blocked
   - Bash output is masked
   - Only non-sensitive UI elements are visible

## Packaged Build Support

Session replay works in both development and packaged builds:

```bash
# Development
npm start

# Packaged build
npm run build
npm run dist:mac  # or dist:win, dist:linux
```

The Amplitude API key is embedded in the build (this is safe - Amplitude keys are designed to be client-side).

## Costs

Amplitude pricing (as of 2026):
- **Free tier**: 10M events/month
- **Session replay**: ~$0.0035 per session

For typical usage:
- 100 users with 10 sessions/month = 1,000 sessions = **$3.50/month**
- 1,000 users with 10 sessions/month = 10,000 sessions = **$35/month**

## Troubleshooting

### Session replay not recording

1. Check that `VITE_AMPLITUDE_API_KEY` is set
2. Check browser console for initialization messages
3. Verify session replay is enabled in Amplitude project settings

### Only seeing anonymous users

1. Check that user is logged in to Papr
2. Verify `getProfile()` returns a `userId`
3. Check console for "identified" vs "anonymous" message

### Sensitive data not masked

1. Add `data-sensitive="true"` to the input element
2. Verify the attribute appears in the DOM (inspect element)
3. Wait for next session replay to verify masking

## Additional Resources

- [Amplitude Session Replay Docs](https://www.docs.developers.amplitude.com/session-replay/)
- [Amplitude Privacy & Security](https://amplitude.com/privacy)
- [User Properties Guide](./AMPLITUDE_ENHANCED_TRACKING.md)
