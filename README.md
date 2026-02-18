# Paprwork V2

AI-powered desktop assistant rebuilt with TypeScript, Electron, and Mastra framework.

## ⚠️ Prerequisites

**Node.js v24 or higher is required.** Electron 40 uses Node v24.13.0 internally, and native modules must match.

```bash
# Check your Node version
node --version  # Should be v24.x.x or higher

# If using nvm (recommended)
nvm install 24
nvm use 24
nvm alias default 24
```

See [docs/NODE_VERSION_REQUIREMENTS.md](docs/NODE_VERSION_REQUIREMENTS.md) for detailed information.

## ✨ Features

- **Liquid Glass Design**: Apple-inspired translucent UI with subtle depth
- **Streaming Chat**: Real-time AI responses with typing indicators
- **Multi-Provider**: Supports Claude, GPT-4, Gemini
- **Type-Safe**: 100% TypeScript with zero `any` types
- **Fast Tools**: Rust-based linting (oxlint) and formatting (oxfmt)

## 🚀 Quick Start

```bash
# 1. Ensure you're using Node v24+
node --version  # Should show v24.x.x

# 2. Install dependencies (auto-rebuilds native modules)
npm install

# 3. Build the app
npm run build

# 4. Start the app
npm start

# Or for development mode
npm run dev
```

**Common Issue:** If you get native module errors, switch to Node v24:
```bash
nvm use 24
npm rebuild
npm start
```

## ✅ Before Committing

```bash
# Run all checks (type-check, lint, format, LOC)
npm run check
```

## 🏗️ Architecture

```
paprwork-v2/
├── src/
│   ├── core/          # Shared library (agents, tools, types)
│   ├── main/          # Electron main process
│   ├── renderer/      # React UI (Liquid Glass design)
│   └── gateway/       # Sub-agents & job orchestration
├── docs/              # Architecture docs
└── scripts/           # Build & migration scripts
```

## 🛠️ Tooling

We use **Rust-based tools** where possible for maximum performance:

| Tool | Technology | Speed |
|------|------------|-------|
| **Linting** | `oxlint` (Rust) | 50-100x faster than ESLint |
| **Formatting** | `oxfmt` (Rust) | 30x faster than Prettier |
| **Type Checking** | `tsc --noEmit` | TypeScript native (no Rust alternative) |
| **Bundling** | Vite (esbuild) | Very fast |

## 📝 Development

```bash
# Type check only (main + renderer)
npm run type-check

# Format code
npm run format

# Lint code
npm run lint

# Check line count (<500 lines per file)
npm run check:loc

# Run all checks
npm run check
```

## 🎨 Design System

Paprwork uses the **Liquid Glass** design language:
- Translucent surfaces with `backdrop-filter: blur(14px)`
- 8pt spacing grid
- SF Pro Display/Text typography
- Subtle shadows and borders
- Smooth 160-220ms transitions

See [`src/renderer/styles/liquid-glass.css`](src/renderer/styles/liquid-glass.css) for the full system.

## 📚 Documentation

- [CLAUDE.md](CLAUDE.md) - AI assistant context & learnings
- [PLAN.md](PLAN.md) - Implementation timeline
- [CONTRIBUTING.md](CONTRIBUTING.md) - Development guidelines
- [docs/architecture/](docs/architecture/) - Architecture decisions

## 🧪 Testing

```bash
npm test              # Run all tests
npm run test:unit     # Unit tests only
npm run test:e2e      # E2E tests only
npm run test:coverage # Coverage report
```

## 📦 Building

```bash
# Build main process
npm run build:main

# Build renderer
npm run build:renderer

# Build gateway
npm run build:gateway

# Build everything
npm run build
```

## 🔄 Migrating from V1

```bash
npm run migrate:v1
```

## License

MIT
