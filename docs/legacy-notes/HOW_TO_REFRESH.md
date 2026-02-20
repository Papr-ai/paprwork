# How to Refresh UI Changes

## Quick Answer

**Hard refresh the browser in Electron:**

```
Cmd+Shift+R (Mac)
Ctrl+Shift+R (Windows/Linux)
```

or

**Fully restart the app:**
```bash
# Stop the app (Ctrl+C in terminal)
npm start
```

---

## When Do You Need to Refresh?

### ✅ Hot Reload (Automatic)

These changes reload automatically via Vite HMR:
- React component changes (`.tsx`, `.jsx`)
- CSS changes (`.css`)
- Most UI code changes

**You should see changes immediately** - no action needed.

### 🔄 Hard Refresh Needed

If you don't see changes, try a hard refresh:
- Bypasses browser cache
- Forces reload of all assets
- **Cmd+Shift+R** (Mac) or **Ctrl+Shift+R** (Windows/Linux)

### 🔁 Full Restart Needed

These require a full `npm start` restart:
- Backend changes (`src/gateway/`, `src/core/`)
- Electron main process changes (`src/electron/`)
- Package.json changes (new dependencies)
- TypeScript config changes

---

## Troubleshooting

### Issue: "I made changes but don't see them"

**Try in order:**

1. **Check terminal** - Look for Vite reload message:
   ```
   [vite] hmr update /ui/components/Chat/ExploringCard.tsx
   ```

2. **Hard refresh** - `Cmd+Shift+R`

3. **Check for errors** - Open DevTools Console (Cmd+Option+I)

4. **Clear cache** - In DevTools:
   - Right-click refresh button
   - Select "Empty Cache and Hard Reload"

5. **Full restart**:
   ```bash
   # Stop (Ctrl+C)
   npm start
   ```

### Issue: "Changes work in dev but not after build"

The production build is separate:

```bash
npm run build        # Build production version
npm run start:prod   # Run production version
```

**Most testing should use `npm start` (development mode).**

---

## Vite HMR (Hot Module Replacement)

Vite watches these files and auto-reloads:
- `ui/**/*.tsx` - React components
- `ui/**/*.ts` - TypeScript files
- `ui/**/*.css` - Stylesheets
- `ui/**/*.json` - Config files

You'll see in terminal:
```
[vite] hmr update /path/to/file.tsx
```

**If you don't see this message**, Vite didn't detect the change.

---

## Current Scenario

You just changed:
- `ui/components/Chat/ExploringCard.tsx`
- `ui/components/Chat/ExploringCard.css`
- `ui/hooks/useAgent.ts`

**These should hot-reload automatically.**

If they didn't:
1. Try **Cmd+Shift+R** first
2. If still not working, **full restart** (`npm start`)

---

## Verification

After refresh, check:

1. **Tool calls show customer-friendly names**:
   - "Listing reach" (not "Running ls -la ~/Dropbox/reach")
   - "Getting info from github.com" (for curl commands)

2. **ExploringCard stays open**:
   - Should NOT auto-collapse after tool calls complete
   - Should stay visible showing completed tool calls
   - Assistant's text response appears below it

3. **No emojis**:
   - No ⏳, ✓, or ✗ symbols

---

## Quick Test

After refresh, send:
```
"List files in my Dropbox reach folder"
```

Expected UI:
```
▼ Deep in thought
  [thinking content]

▼ Exploring
  → Listing reach

[Assistant's text response about the files found]
```

**The "Exploring" card should stay open** (not collapse).
