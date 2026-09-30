# Authentication Reliability Improvement Plan

**Goal:** Achieve 100% authentication success rate for desktop users.

**Current Success Rate:** ~90-95% (fails when localhost/deep link both blocked)  
**Target Success Rate:** 100%

---

## How Other Apps Achieve 100% Reliability

| App | Method | Why It Works |
|-----|--------|--------------|
| **VS Code** | Dynamic port + manual code entry | Code entry always works |
| **1Password** | Localhost + secret key fallback | Manual entry bypasses network |
| **Slack** | Localhost + email magic link | Multiple channels |
| **Figma** | Localhost + manual token paste | Manual entry as safety net |

**Key Insight:** Apps achieving 100% reliability ALWAYS have a manual fallback that doesn't depend on network mechanics.

---

## Proposed Architecture: Triple Fallback

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Improved Auth Flow                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  LAYER 1: Localhost HTTP (Primary - works 95% of time)              │
│  ├── Try ports 18791, 18792, 18793... (dynamic selection)           │
│  └── Falls through if port binding fails                            │
│                                                                      │
│  LAYER 2: Deep Link Protocol (Secondary - works 98% when L1 fails)  │
│  ├── papr://auth/callback                                           │
│  └── Falls through if not registered/blocked                        │
│                                                                      │
│  LAYER 3: Manual Code Entry (Tertiary - works 100%)                 │
│  ├── Show 6-character code on success page in browser               │
│  ├── User types code into app input field                           │
│  └── Code exchanged server-side for session                         │
│                                                                      │
│  LAYER 4: Server-Side Polling (Background - detects success)        │
│  ├── After browser opens, poll dashboard API every 2 seconds        │
│  └── If session detected, complete auth silently                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Details

### 1. Dynamic Port Selection

```typescript
// OAuthCallbackServer.ts
async function findAvailablePort(startPort: number, maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error("No available ports found");
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}
```

### 2. Manual Code Entry Fallback

**Browser side (success page):**
```html
<div class="card">
  <div class="check">✓</div>
  <h1>You're signed in</h1>
  <p>Go back to Papr Work on your computer. We'll connect your account automatically.</p>
  
  <!-- Fallback code for manual entry -->
  <div class="fallback-code">
    <p class="hint">If Papr Work still doesn't show you as signed in, enter this code there:</p>
    <div class="code-display">AB3-K9F</div>
  </div>
</div>
```

**App side (AuthWall.tsx):**
```tsx
{showManualEntry && (
  <div className="auth-wall-manual-entry">
    <p>Having trouble? Enter the code from your browser:</p>
    <input
      type="text"
      placeholder="ABC-123"
      value={manualCode}
      onChange={(e) => setManualCode(e.target.value.toUpperCase())}
      maxLength={7}
      className="auth-wall-code-input"
    />
    <button onClick={handleManualCodeSubmit}>
      Verify Code
    </button>
  </div>
)}
```

**Backend flow:**
1. Generate 6-char code when Auth0 login succeeds (server-side)
2. Store code → session mapping in Redis/DB (5 min TTL)
3. Show code on browser success page
4. App sends code to `/api/auth/verify-code` endpoint
5. Server validates code, returns session token

### 3. Server-Side Session Polling

```typescript
// Poll the dashboard API to check if login completed
async function pollForLoginCompletion(state: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${PAPR_PLATFORM_URL}/api/desktop-auth/check?state=${state}`,
      { headers: { "X-Desktop-App": "paprwork" } }
    );
    const data = await response.json();
    return data.completed === true;
  } catch {
    return false;
  }
}

// In AuthWall, poll every 2 seconds
useEffect(() => {
  if (!isAuthenticating || !authState) return;
  
  const interval = setInterval(async () => {
    const completed = await pollForLoginCompletion(authState);
    if (completed) {
      // Fetch session details and complete auth
      await completeAuthFromServer(authState);
    }
  }, 2000);
  
  return () => clearInterval(interval);
}, [isAuthenticating, authState]);
```

### 4. Improved UX Timeline

| Time | Current Behavior | Proposed Behavior |
|------|-----------------|-------------------|
| 0s | Waiting... | Waiting (with progress indicator) |
| 5s | Still waiting | Show "Check again" button |
| 10s | Still waiting | Show manual code entry option |
| 15s | Still waiting | Show troubleshooting tips |
| 30s | Still waiting | Offer to retry with different method |
| 90s | Show error | (User should have succeeded by now) |

---

## Phase 1: Quick Wins (1-2 days)

1. **Dynamic port selection** - Try 10 ports instead of fixed 18791
2. **Faster feedback** - Show "Check again" after 5 seconds, not 90
3. **Better error messages** - Explain what went wrong and how to fix

## Phase 2: Manual Fallback (3-5 days)

1. **Generate verification code** - 6-char alphanumeric on successful Auth0 login
2. **Display code on success page** - User sees it in browser
3. **Add code input to AuthWall** - User can type code if automatic fails
4. **Verify code endpoint** - Backend validates and returns session

## Phase 3: Server-Side Polling (2-3 days)

1. **Track auth attempts server-side** - Store state → pending/completed
2. **Add check endpoint** - Desktop polls to see if login completed
3. **Complete auth from server** - If poll succeeds, fetch credentials server-side

---

## Expected Results

| Failure Scenario | Current | After Phase 1 | After Phase 2 | After Phase 3 |
|-----------------|---------|---------------|---------------|---------------|
| Port 18791 in use | ❌ Fails | ✅ Tries other ports | ✅ | ✅ |
| Firewall blocks localhost | ❌ Fails | ⚠️ Deep link fallback | ✅ Manual code | ✅ |
| Deep link not registered | ❌ Fails | ⚠️ Timeout | ✅ Manual code | ✅ |
| Both localhost + deep link fail | ❌ Fails | ❌ Fails | ✅ Manual code | ✅ |
| User closes browser too fast | ❌ Fails | ❌ Fails | ⚠️ Partial | ✅ Server polling |

**Success rate:** 90% → 95% → 99% → 100%

---

## Code Changes Required

### Phase 1 Files:
- `src/core/services/OAuthCallbackServer.ts` - Add dynamic port selection
- `src/electron/ipc/paprAuthCallbackServer.ts` - Use dynamic ports
- `ui/components/Auth/AuthWall.tsx` - Faster feedback timeline

### Phase 2 Files:
- `papr-dev-platform/apps/web/app/api/auth/generate-code/route.ts` - NEW
- `papr-dev-platform/apps/web/app/api/auth/verify-code/route.ts` - NEW
- `src/electron/ipc/paprLogin.ts` - Add code verification
- `ui/components/Auth/AuthWall.tsx` - Add manual code input UI

### Phase 3 Files:
- `papr-dev-platform/apps/web/app/api/desktop-auth/check/route.ts` - NEW
- `src/electron/ipc/paprLogin.ts` - Add server polling

---

## Appendix: Industry Patterns

### VS Code's Approach
1. Start localhost server on dynamic port
2. Open browser with port in redirect_uri
3. If callback received → success
4. If timeout (60s) → show "paste authentication code" prompt
5. User copies code from browser, pastes into VS Code

### 1Password's Approach
1. Try localhost callback
2. If fails → show "Enter your Secret Key" prompt
3. User enters their setup key manually
4. This ALWAYS works because it's just text input

### Slack's Approach
1. Try localhost callback + deep link simultaneously
2. Poll server every 2 seconds for session
3. Whichever succeeds first wins
4. Fallback: "Send me a sign-in link" (email)
