# Runtime Error Fix: Cannot access 'b' before initialization

## Problem

The app was throwing a `ReferenceError: Cannot access 'b' before initialization` error at runtime, even though TypeScript compilation and build succeeded.

## Root Cause

**Complex logging in render scope causes bundler circular dependencies.**

In `ui/App.tsx`, we had multiple `console.log` statements directly in the component body (render scope) that used `.map()` on state variables:

```typescript
// ❌ PROBLEMATIC CODE (in render scope)
console.log(`[App]   - tabs:`, tabs.map(t => ({ id: t.id, entityId: t.entityId })));
```

When Vite minifies and tree-shakes the code, complex operations in render scope can create circular references that fail at runtime with cryptic variable names like `'b'`.

## Solution

**Move complex logging into `useEffect` hooks:**

```typescript
// ✅ FIXED (in useEffect)
useEffect(() => {
  console.log('[App] ========== RENDER ==========');
  console.log(`[App]   - tabs.length: ${tabs.length}`);
  console.log(`[App]   - activeTabId: ${activeTabId}`);
  console.log(`[App]   - hydrated: ${hydrated}`);
});
```

## Why This Works

1. **Execution Timing**: `useEffect` runs after render completes, avoiding initialization conflicts
2. **Bundler Optimization**: Simpler code in render scope = better tree-shaking
3. **Scope Isolation**: Effect callbacks are isolated from render closure complexities

## Files Changed

- `ui/App.tsx` - Moved render logs to `useEffect`
- `ui/components/Chat/ChatContainer.tsx` - Already fixed in previous session

## Prevention

**Best Practices**:
1. Keep render scope minimal (no complex operations)
2. Move all logging to `useEffect` hooks
3. Avoid `.map()`, spread operators, or object creation in render scope logging
4. Test production builds (`npm run build`) not just dev mode

## Verification

```bash
# Build succeeds
npm run build
# ✅ Success

# Runtime works
npm start
# ✅ No ReferenceError

# Check browser console
# ✅ Logs appear correctly
# ✅ No "Cannot access 'b'" errors
```

## Related Issues

- Previously fixed similar issue in `ChatContainer.tsx` (line 74-79)
- This is a common pitfall with React + Vite + minification
- More likely to occur in production builds than dev mode

## Key Takeaway

**Never put complex logic or operations in component render scope, even if it's "just logging"!**

The bundler/minifier may optimize it in ways that cause runtime errors. Always use `useEffect` for any non-trivial operations, including logging complex state.
