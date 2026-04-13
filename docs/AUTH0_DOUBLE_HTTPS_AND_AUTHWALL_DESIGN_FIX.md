# Auth0 Double HTTPS & AuthWall Split-Screen Design Fix

**Added:** 2026-04-11  
**Status:** ✅ FIXED

## Problems

### Problem 1: Double HTTPS in Auth0 URL
Auth0 OAuth URLs were malformed with double `https://` prefix:
```
https://https//papr-development.auth0.com/authorize?...
&audience=https%3A%2F%2Fhttps%3A%2F%2Fpapr-development.auth0.com%2Fuserinfo
```

This caused the OAuth flow to fail completely because the URL was invalid.

### Problem 2: AuthWall Design
Needed professional split-screen layout matching the onboarding design:
- Left side: Sign-in form with gradient background
- Right side: Papr logo + typefont + Fold geometric pattern

## Root Cause

### Issue 1: AUTH0_DOMAIN with HTTPS prefix
The `AUTH0_DOMAIN` environment variable included `https://` prefix:
```bash
AUTH0_DOMAIN=https://papr-development.auth0.com
```

But the code added `https://` again:
```typescript
const authUrl = new URL(`https://${AUTH0_DOMAIN}/authorize`);
// Results in: https://https://papr-development.auth0.com/authorize
```

## Solutions

### Fix 1: Strip HTTPS Prefix from AUTH0_DOMAIN

**File:** `src/electron/ipc/paprLogin.ts`

Added automatic stripping of protocol prefix:

```typescript
// Auth0 configuration — env vars for dev, defaults for prod
// Remove https:// prefix if present (to avoid double https in URLs)
const AUTH0_DOMAIN = (process.env.AUTH0_DOMAIN || "papr.auth0.com").replace(/^https?:\/\//, "");
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID || "asVGkVRkRAxYvtQadqivntIRjB4D1Iur";
```

**Important:** The defaults use production Auth0 (`papr.auth0.com`). The client ID `asVGkVRkRAxYvtQadqivntIRjB4D1Iur` is registered in the production tenant. If you need to use a different tenant (e.g., development), ensure the client ID matches that tenant:

```bash
# For production (default, no env vars needed)
# Uses: papr.auth0.com / asVGkVRkRAxYvtQadqivntIRjB4D1Iur

# For development tenant (example)
export AUTH0_DOMAIN=papr-development.auth0.com
export AUTH0_CLIENT_ID=your-dev-client-id

# ALWAYS set domain WITHOUT https:// prefix
```

### Fix 2: Split-Screen AuthWall Design

**File:** `ui/components/Auth/AuthWall.tsx`

Created split-screen layout:

**Left Side - Sign-In Form:**
```tsx
<div className="auth-wall-left">
  <div className="auth-wall-form">
    <h1 className="auth-wall-title">Welcome!</h1>
    <p className="auth-wall-subtitle">Sign up to unfold knowledge</p>
    
    <button className="auth-wall-login-button" onClick={handleLogin}>
      Sign In
    </button>
    
    <div className="auth-wall-footer">
      <p className="auth-wall-footer-text">
        I already have an account? <button className="auth-wall-link">Sign in</button>
      </p>
      <p className="auth-wall-terms">By signing up you agree to the terms of use</p>
    </div>
  </div>
</div>
```

**Right Side - Papr Branding:**
```tsx
<div className="auth-wall-right">
  <div className="auth-wall-branding">
    {/* Papr Logo + Typefont */}
    <div className="auth-wall-papr-logo">
      <img src="/images/papr-logo.svg" alt="Papr Logo" className="auth-wall-logo-icon" />
      <img src="/images/papr typefont.svg" alt="Papr" className="auth-wall-logo-text" />
    </div>

    {/* Fold SVG Background */}
    <div className="auth-wall-fold">
      <svg viewBox="0 0 300 270">...</svg>
    </div>
  </div>
</div>
```

**File:** `ui/components/Auth/AuthWall.css`

**Split-Screen Layout:**
```css
.auth-wall--split {
  flex-direction: row;
}

.auth-wall-left {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
  padding: 48px;
}

.auth-wall-right {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  position: relative;
  overflow: hidden;
}
```

**Logo Composition:**
```css
.auth-wall-papr-logo {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  z-index: 2;
}

.auth-wall-logo-icon {
  width: 120px; /* P icon */
}

.auth-wall-logo-text {
  width: 240px; /* "papr" wordmark */
}
```

**Fold Background:**
```css
.auth-wall-fold {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 60%;
  z-index: 1;
  opacity: 0.9;
}
```

## Design Details

### Left Side:
- **Background:** Light gradient (#f8f9fa → #e9ecef)
- **Title:** "Welcome!" (48px, bold, -0.02em letter spacing)
- **Subtitle:** "Sign up to unfold knowledge" (16px, 50% opacity)
- **Button:** Full-width, #0080FF, 12px radius, hover lift
- **Footer:** "I already have an account?" + terms notice
- **Dark mode:** Switches to dark gradient (#0f172a → #1e293b)

### Right Side:
- **Background:** White (#ffffff in light, #1e293b in dark)
- **Logo Icon:** papr-logo.svg (120px width, gradient blue P)
- **Logo Text:** papr typefont.svg (240px width, "papr" wordmark)
- **Fold Pattern:** Bottom-right corner, 60% width, opacity 0.9
- **Layout:** Logo centered, fold pattern absolute positioned

### Responsive Behavior:
- **Desktop (>1024px):** 50/50 side-by-side
- **Tablet (768-1024px):** Stacked (60% form, 40% branding)
- **Mobile (<768px):** Full stack, smaller logo sizes

## Visual Layout

```
┌─────────────────────────┬─────────────────────────┐
│  LEFT (Form)            │  RIGHT (Branding)       │
│                         │                         │
│  Welcome!               │      [P Logo Icon]      │
│  Sign up to unfold...   │                         │
│                         │       "p a ϸ r"        │
│  ┌────────────────────┐ │                         │
│  │     Sign In        │ │                         │
│  └────────────────────┘ │             /\          │
│                         │            /  \         │
│  I already have...      │           /____\        │
│  By signing up...       │         (Fold.svg)      │
│                         │                         │
└─────────────────────────┴─────────────────────────┘
```

## Assets Used

All SVG files already exist in `ui/public/images/`:

1. **papr-logo.svg** (105×124)
   - Gradient blue "P" icon
   - Used at 120px width on right side

2. **papr typefont.svg** (284×140)
   - "papr" wordmark with all letters
   - Used at 240px width below P icon

3. **Fold.svg** (300×270)
   - Blue geometric triangular pattern
   - Positioned bottom-right at 60% width

## Testing

### Test Auth0 URL Fix:
1. Set `AUTH0_DOMAIN=https://papr-development.auth0.com` in environment
2. Click "Sign In"
3. Check console → should show `https://papr-development.auth0.com/authorize` (single https)
4. Browser opens correctly
5. OAuth flow completes

### Test Split-Screen Design:
1. Start with `REQUIRE_PAPR_AUTH=true`
2. Verify layout:
   - ✅ Left: Light gradient, "Welcome!", blue button
   - ✅ Right: White background, P logo (120px), "papr" text (240px), Fold pattern
3. Hover button → lifts with shadow
4. Resize window → stacks on mobile
5. Toggle dark mode → adapts correctly

## Files Changed

- `src/electron/ipc/paprLogin.ts` - Strip protocol prefix
- `ui/components/Auth/AuthWall.tsx` - Split-screen layout with real logo files
- `ui/components/Auth/AuthWall.css` - Split-screen styles
- `docs/AUTH0_DOUBLE_HTTPS_AND_AUTHWALL_DESIGN_FIX.md` - Documentation

## Impact

### Auth0 URL Fix:
- **Before:** OAuth broken (double https in URL)
- **After:** Works with any AUTH0_DOMAIN format ✅

### Design Fix:
- **Before:** Centered card with inline SVG
- **After:** Professional split-screen with branded assets ✅

## Environment Variable Format

Supports both formats:
```bash
# Without protocol (recommended)
AUTH0_DOMAIN=papr.auth0.com

# With protocol (now handled)
AUTH0_DOMAIN=https://papr.auth0.com
```
