# Installation & Build Instructions

**Quick reference for users setting up Paprwork V2**

---

## Prerequisites

- **Node.js v24+** (required for Electron 40)
- npm v10+
- macOS, Windows, or Linux

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/Papr-ai/paprwork-v2.git
cd paprwork-v2

# 2. Switch to Node v24+ (if using nvm)
nvm use 24

# 3. Install all dependencies
npm install

# 4. Build the application
npm run build

# 5. Run the application
npm start
```

That's it! 🎉

---

## What `npm install` Does

This project uses [npm workspaces](https://docs.npmjs.com/cli/v10/using-npm/workspaces), so running `npm install` once at the root:

1. ✅ Installs all root dependencies (Electron, backend, AI SDKs)
2. ✅ Installs all UI dependencies (React, TipTap, markdown libraries)
3. ✅ Rebuilds native modules (better-sqlite3) for your platform
4. ✅ Creates a single `node_modules/` with everything

**You don't need to run `npm install` separately in the `ui/` folder.**

---

## Troubleshooting

### "Cannot resolve import" errors

If you get build errors about missing modules:

```bash
# Clean everything and reinstall
rm -rf node_modules ui/node_modules package-lock.json
npm install
npm run build
```

### Wrong Node version

```bash
# Check your Node version
node -v

# Should show v24.x.x or higher
# If not, install Node v24:
nvm install 24
nvm use 24
```

### Native module errors

If `better-sqlite3` fails to load:

```bash
# Rebuild native modules for your platform
npx @electron/rebuild
```

---

## Development Mode

For development with hot reload:

```bash
# Terminal 1: Gateway process
npm run gateway:dev

# Terminal 2: UI with Vite HMR
npm run ui:dev

# Terminal 3: Electron app
npm run electron:dev

# Or run all three at once:
npm run dev
```

---

## Building for Distribution

```bash
# Build all components
npm run build

# Package for your platform (creates installers)
npm run package
```

---

## Questions?

- **Docs:** [README.md](../README.md) | [docs/](../docs/)
- **Issues:** [GitHub Issues](https://github.com/Papr-ai/paprwork-v2/issues)
- **Workspaces:** [docs/NPM_WORKSPACES_SETUP.md](NPM_WORKSPACES_SETUP.md)
