# NPM Workspaces Setup

**Date:** 2026-02-24  
**Issue:** Users getting "cannot resolve import" errors after `npm install`

---

## Problem

Users cloning the repo and running:

```bash
npm install
npm run build
```

Were getting errors like:

```
[vite]: Rollup failed to resolve import "remark-gfm" from "ui/components/common/Markdown.tsx"
```

**Root Cause:** The project had two separate `package.json` files (root and `ui/`), but `npm install` only installed root dependencies. When Vite tried to build the UI, it couldn't find packages listed in `ui/package.json` because they weren't installed.

---

## Solution: npm Workspaces

**npm workspaces** is a built-in feature (npm v7+) that manages dependencies for monorepos with multiple `package.json` files.

### Configuration

**Root `package.json`:**
```json
{
  "workspaces": ["ui"]
}
```

This tells npm that `ui/` is a workspace. Now when you run `npm install` at the root:

1. ✅ Installs root dependencies → `node_modules/`
2. ✅ Installs `ui/` dependencies → **also** in root `node_modules/` (hoisted)
3. ✅ Creates symlinks so both root and `ui/` can resolve packages
4. ✅ Deduplicates shared dependencies (like `react`, `zustand`)

### How It Works

With workspaces:

```
paprwork-v2/
├── node_modules/           # All dependencies (root + ui)
│   ├── react/              # Shared by both
│   ├── remark-gfm/         # UI-specific, but hoisted
│   ├── rehype-katex/       # UI-specific, but hoisted
│   ├── @tiptap/            # UI-specific, but hoisted
│   └── ...
├── ui/
│   ├── node_modules/       # Usually empty (everything hoisted)
│   │   └── .bin/           # Bin symlinks only
│   └── package.json        # UI dependencies declared here
└── package.json            # Root + workspaces config
```

Node's module resolution automatically finds packages in the root `node_modules`, so the UI build works correctly.

---

## User Instructions

**For users cloning the repo:**

```bash
# 1. Switch to Node v24+
nvm use 24

# 2. Install everything (one command!)
npm install

# 3. Build
npm run build

# 4. Run
npm start
```

That's it! No need to run `npm install` separately in `ui/`.

---

## Benefits

1. **Single install command** - Users don't need to know about nested package.json files
2. **Dependency deduplication** - Shared packages (like `react`) only installed once
3. **Atomic updates** - `package-lock.json` tracks all workspace dependencies
4. **Cleaner CI** - Just `npm install` in root, everything works
5. **Better hoisting** - npm automatically optimizes dependency tree

---

## Workspace Commands

```bash
# Install/update all workspaces
npm install

# Run script in specific workspace
npm run build --workspace=ui
# or shorter:
npm run build -w ui

# Run script in all workspaces
npm run test --workspaces

# Add dependency to specific workspace
npm install react-router-dom --workspace=ui
```

---

## Dependencies Organization

**Root `package.json`:**
- Electron dependencies (`electron`, `electron-builder`)
- Backend dependencies (`better-sqlite3`, `express`, `ws`)
- AI/Agent dependencies (`@mastra/core`, `@ai-sdk/*`, `@mariozechner/pi-ai`)
- Shared utilities (`uuid`, `fs-extra`, `zod`)
- Dev tools (`typescript`, `tsx`, `vitest`, `oxlint`, `oxfmt`)
- Document processing (`docx`, `mammoth`, `turndown`)

**UI `package.json`:**
- React ecosystem (`react`, `react-dom`)
- UI libraries (`@tiptap/*`, `react-markdown`, `recharts`)
- Markdown rendering (`remark-gfm`, `remark-math`, `rehype-katex`)
- Syntax highlighting (`react-syntax-highlighter`)
- UI utilities (`tippy.js`, `zustand`)
- UI dev dependencies (`@vitejs/plugin-react`, `vite`, `happy-dom`)
- Testing libraries (`@testing-library/react`, `@testing-library/jest-dom`)

**Why this split?**
- Keeps UI dependencies isolated
- Clearer what's used where
- UI can be published separately if needed

---

## Migration Notes

**Changes made (2026-02-24):**

1. Added `"workspaces": ["ui"]` to root `package.json`
2. Moved UI-specific dependencies to `ui/package.json`:
   - `@tiptap/*` packages (editor)
   - Markdown packages (`remark-gfm`, `remark-math`, `rehype-katex`)
   - Syntax highlighter (`react-syntax-highlighter`)
   - UI libraries (`recharts`, `tippy.js`, `tiptap-markdown`)
3. Added `"private": true` to `ui/package.json` (workspace best practice)
4. Updated README with workspace installation instructions

**Result:** Users can now run `npm install` once at the root and everything works!

---

## Troubleshooting

### "Cannot resolve import" errors

```bash
# Clean everything and reinstall
rm -rf node_modules ui/node_modules package-lock.json
npm install
```

### Dependency conflicts

If you get peer dependency warnings, check that versions match between root and `ui/package.json`. For shared packages like `react`, they should have the same version range.

### Build still fails

1. Verify Node version: `node -v` (should be v24+)
2. Check that `remark-gfm` exists: `ls node_modules | grep remark-gfm`
3. Try building UI directly: `cd ui && vite build`

---

## References

- [npm workspaces documentation](https://docs.npmjs.com/cli/v10/using-npm/workspaces)
- [Monorepo best practices](https://monorepo.tools/)
