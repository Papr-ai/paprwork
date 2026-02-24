# Quick Fix: Missing remark-gfm Error

If you're getting this error when building:

```
[vite]: Rollup failed to resolve import "remark-gfm" from "ui/components/common/Markdown.tsx"
```

You need to either **pull the latest changes** (recommended) or **manually add the missing dependencies** (temporary fix).

---

## Option 1: Pull Latest Changes (Recommended)

The project now uses npm workspaces, which fixes this issue permanently:

```bash
# Pull the latest code
git pull origin master

# Clean install
rm -rf node_modules ui/node_modules package-lock.json
npm install

# Build
npm run build
```

---

## Option 2: Manual Fix (Temporary)

If you can't pull the latest changes yet, manually add the missing dependencies to `ui/package.json`:

```bash
cd ui
npm install remark-gfm remark-math rehype-katex react-syntax-highlighter @tiptap/extension-placeholder @tiptap/extension-underline @tiptap/pm @tiptap/react @tiptap/starter-kit @tiptap/suggestion tippy.js tiptap-markdown recharts
cd ..
npm run build
```

**Note:** This is a temporary workaround. The proper fix is to use npm workspaces (Option 1).

---

## What Changed?

The project now uses [npm workspaces](https://docs.npmjs.com/cli/v10/using-npm/workspaces). Running `npm install` at the root automatically installs dependencies for both the main app and the `ui/` folder.

**Before (broken):**
- Users had to manually install dependencies in `ui/`
- Easy to miss, causing build errors

**After (fixed):**
- One `npm install` at root installs everything
- Dependencies properly resolved by Vite
- No manual steps needed

---

## Still Having Issues?

1. **Verify you're on Node v24+:**
   ```bash
   node -v  # Should show v24.x.x or higher
   nvm use 24
   ```

2. **Clean everything and reinstall:**
   ```bash
   rm -rf node_modules ui/node_modules package-lock.json
   npm install
   ```

3. **Check workspace setup:**
   ```bash
   grep -A2 '"workspaces"' package.json
   # Should show: "workspaces": ["ui"]
   ```

4. **Verify dependencies are installed:**
   ```bash
   ls node_modules | grep remark-gfm
   # Should show: remark-gfm
   ```

---

**See also:**
- [docs/NPM_WORKSPACES_SETUP.md](NPM_WORKSPACES_SETUP.md) - Full explanation
- [INSTALL.md](../INSTALL.md) - Installation guide
- [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) - More troubleshooting
