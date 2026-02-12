# Paprwork V2

AI-powered desktop assistant rebuilt with TypeScript, Electron, and Mastra framework.

## ✨ Features

- **Liquid Glass Design**: Apple-inspired translucent UI with subtle depth
- **Streaming Chat**: Real-time AI responses with typing indicators
- **Multi-Provider**: Supports Claude, GPT-4, Gemini
- **Type-Safe**: 100% TypeScript with zero `any` types
- **Fast Tools**: Rust-based linting (oxlint) and formatting (oxfmt)

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Build main process (first time only)
npm run build:main

# Start development (Vite + Electron)
npm run dev

# Or run full build + start
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
