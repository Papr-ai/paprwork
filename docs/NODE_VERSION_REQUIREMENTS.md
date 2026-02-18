# Node Version Requirements

**Last Updated:** 2026-02-16

## Critical Requirement: Node v24+

Paprwork V2 **requires Node.js v24 or higher** to run properly.

### Why Node v24?

1. **Electron 40 Compatibility**
   - Electron 40 uses embedded Node v24.13.0
   - Native modules (like `better-sqlite3`) must be compiled for the same Node version
   - NODE_MODULE_VERSION must match (143 for Node v24)

2. **Tool Dependencies**
   - `@electron/rebuild` requires Node v24+ features (e.g., `util.styleText`)
   - The postinstall script automatically rebuilds native modules using `@electron/rebuild`

3. **Build Process**
   - TypeScript compilation works on any recent Node version
   - But the Electron runtime requires Node v24+ compiled native modules

## Quick Setup

### Using nvm (Recommended)

```bash
# Install Node v24 (if not already installed)
nvm install 24

# Switch to Node v24
nvm use 24

# Set Node v24 as default (optional)
nvm alias default 24

# Install dependencies (auto-rebuilds native modules)
npm install
```

The repository includes a `.nvmrc` file with `24`, so you can simply run:

```bash
nvm use
npm install
```

### Verification

Check your Node version before running any commands:

```bash
node --version
# Should output: v24.x.x (e.g., v24.13.1)
```

Check the Electron Node version:

```bash
npm start
# Look for: [Gateway] Node: v24.13.0
```

## Common Issues & Solutions

### Issue 1: Native Module Version Mismatch

**Error:**
```
Error: The module 'better_sqlite3.node' was compiled against a different Node.js version
NODE_MODULE_VERSION 108. This version requires NODE_MODULE_VERSION 143.
```

**Cause:** You're using Node v18 or older, but Electron requires Node v24.

**Solution:**
```bash
nvm use 24
npm rebuild
# or
npx @electron/rebuild
```

### Issue 2: @electron/rebuild Fails

**Error:**
```
TypeError: util.styleText is not a function
```

**Cause:** `@electron/rebuild` requires Node v24+ features.

**Solution:**
```bash
nvm use 24
npx @electron/rebuild
```

### Issue 3: Wrong Node Version After Restart

**Problem:** Node reverts to v18 after opening a new terminal.

**Solution:** Set Node v24 as default:
```bash
nvm alias default 24
```

## Package.json Configuration

The `package.json` enforces Node v24+ via the `engines` field:

```json
{
  "engines": {
    "node": ">=24.0.0",
    "npm": ">=10.0.0"
  },
  "scripts": {
    "postinstall": "npx @electron/rebuild"
  }
}
```

This ensures:
- npm warns if you're using the wrong Node version
- Native modules rebuild automatically after `npm install`

## CI/CD Considerations

If setting up CI/CD pipelines, ensure:

1. **Node v24+ is used** in all build steps
2. **Native modules are rebuilt** after installing dependencies
3. **Platform-specific builds** use the correct Node version for that platform

Example GitHub Actions:

```yaml
jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm install
      - run: npm run build
```

## Reference

- Electron 40 Release Notes: https://www.electronjs.org/docs/latest/breaking-changes#planned-breaking-api-changes-400
- Node.js Release Schedule: https://nodejs.org/en/about/previous-releases
- `@electron/rebuild` Documentation: https://github.com/electron/rebuild

---

**Summary:** Always use Node v24+ when working on Paprwork V2. The `.nvmrc` file and `package.json` engines field enforce this requirement.
