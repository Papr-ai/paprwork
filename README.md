<div align="center">

# 🚀 Paprwork V2

**AI-Powered Desktop Assistant** — Rebuilt with TypeScript and Mastra

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node Version](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue)](https://www.typescriptlang.org/)

[Features](#-features) • [Quick Start](#-quick-start) • [Architecture](#-architecture) • [Documentation](#-documentation) • [Contributing](#-contributing)

</div>

---

## ✨ Features

- **🤖 Multi-Provider AI Support** - Claude, GPT, and Gemini models with seamless switching
- **⚡ Streaming Responses** - Real-time AI responses with proper tool execution
- **🛠️ Extensible Tool System** - Bash execution, filesystem operations, document processing
- **📋 Parallel Chat Sessions** - Multiple concurrent AI conversations
- **⏱️ Scheduled Jobs & Automation** - Python/Node/Swift jobs with cron scheduling
- **🧠 Smart Memory System** - Context-aware conversations with Papr Memory integration
- **🎨 Mini-Apps** - TypeScript apps with SQLite database access
- **👥 Sub-Agents** - Specialized AI agents for research, code review, and more
- **🔐 Secure Custom Keys** - Manage your own API keys with encrypted storage
- **💻 Cross-Platform** - macOS, Windows, and Linux support

---

## 🚀 Quick Start

### Prerequisites

- **Node.js v24+** (required for Electron 40)
- npm v10+
- macOS, Windows, or Linux

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/Papr-ai/paprwork.git
cd paprwork

# 2. Use Node v24+ (with nvm)
nvm use 24

# 3. Install all dependencies (includes UI workspace)
npm install

# 4. Configure API keys
cp .env.example .env.local
# Edit .env.local and add your API keys

# 5. Start the application
npm start
```

**Note:** This project uses [npm workspaces](https://docs.npmjs.com/cli/v10/using-npm/workspaces). Running `npm install` at the root automatically installs dependencies for both the main app and the `ui/` workspace. You don't need to run `npm install` separately in the `ui/` folder.

**Troubleshooting:**
- If you get "cannot find module" errors during build, delete `node_modules` and `ui/node_modules`, then run `npm install` again
- Make sure you're using Node v24+ (`node -v` should show v24.x.x)

### Development Mode

```bash
# Run in development mode with hot reload
npm run dev

# In separate terminals:
npm run gateway:dev  # Gateway process
npm run ui:dev       # UI with Vite HMR
npm run electron:dev # Electron app
```

---

## 🏗️ Architecture

Paprwork V2 is built with a modern, modular architecture inspired by [OpenClaw](https://github.com/openclaw/openclaw) (179k+ stars):

```
paprwork-v2/
├── src/
│   ├── core/               # Shared library (zero duplication!)
│   │   ├── agents/         # MastraAgent, SessionManager
│   │   ├── tools/          # Tool implementations
│   │   └── types/          # Type definitions
│   ├── electron/           # Main Electron process (CommonJS)
│   ├── gateway/            # Gateway process for sub-agents & jobs
│   └── resources/          # Agent docs, skills, templates
├── ui/                     # React UI (Vite + TypeScript)
├── docs/                   # Documentation
└── tests/                  # Comprehensive test suite
```

### Key Design Principles

1. **100% TypeScript** - Full type safety, zero `any` types
2. **Small, Modular Files** - Max 500 lines per file (enforced by CI)
3. **Shared Core Library** - Zero code duplication between processes
4. **Mastra Framework** - Reliable multi-provider AI orchestration
5. **Rust-Based Tools** - `oxlint` and `oxfmt` for 50-100x faster dev workflow

### Optional usage telemetry

The desktop app can send **anonymous, coarse usage events** (for example app started or quit) to help measure adoption. This follows the same **proxy pattern** as [Papr Memory OSS](https://github.com/Papr-ai/memory): the app **never** embeds an Amplitude API key; events are `POST`ed to `https://memory.papr.ai/v1/telemetry/events`, and the server forwards to Amplitude.

- **Default:** **On** for **packaged** installs (Mac/Windows/Linux downloads from releases). **Off** when running from source/dev (`electron` unpackaged). Change anytime under **Settings → Privacy**. `PAPRWORK_TELEMETRY_ENABLED=true|false` still overrides the stored preference.
- **Disable:** Turn off in **Settings → Privacy**, or set `PAPRWORK_TELEMETRY_ENABLED=false` (forces off regardless of package default).
- **Custom endpoint:** Set `PAPRWORK_TELEMETRY_URL` to your own proxy base URL (must be `http://` or `https://`). Set `PAPRWORK_TELEMETRY_URL=` (empty) to block all telemetry network calls.
- **Not collected:** Chat content, prompts, file paths, API keys, or personal data. Implementation: `src/core/telemetry/`.
- **Operational signals (gateway):** When telemetry is on, the jobs gateway may emit coarse diagnostics (for example `paprwork_job_failed`, `paprwork_scheduler_cron_parse_error`, throttled `paprwork_scheduler_tick`) with **no stack traces** and **no stderr**. This helps spot patterns in Amplitude; it is **not** a full crash/bug reporter. For deep production error tracking, add something like Sentry separately.

---

## 📚 Documentation

- **[Architecture Overview](docs/architecture/SYSTEM_OVERVIEW.md)** - Deep dive into system design
- **[Development Guide](CLAUDE.md)** - Key learnings and patterns
- **[API Documentation](docs/README.md)** - Comprehensive API reference
- **[Testing Guide](docs/TESTING_GUIDE.md)** - Unit, integration, and E2E tests
- **[Contributing Guidelines](CONTRIBUTING.md)** - How to contribute

### Quick Links

- [Setting up Custom API Keys](docs/CUSTOM_KEYS.md)
- [Creating Jobs & Automation](docs/architecture/PORTABLE_BUNDLE_SPEC.md)
- [Building Sub-Agents](src/resources/agent-docs/SUBAGENT_CREATION_GUIDE.md)
- [Tool Development](src/core/tools/README.md)

---

## 🛠️ Development

### Code Quality

```bash
# Run all checks (type-check + format + lint + LOC)
npm run check

# Format code with oxfmt (Rust, 30x faster)
npm run format

# Lint with oxlint (Rust, 50-100x faster)
npm run lint

# Type checking (TypeScript)
npm run type-check
```

### Testing

```bash
# Run all tests
npm run test

# Unit tests (backend)
npm run test:unit

# Unit tests (UI)
npm run test:ui

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e

# Watch mode
npm run test:watch
```

### Building

```bash
# Build all components
npm run build

# Build individual components
npm run build:gateway
npm run build:electron
npm run build:ui

# Package for distribution
npm run package
```

---

## 🌟 Why V2?

Paprwork V1 accumulated technical debt over time:
- 30,335 lines in monolithic files
- 90% code duplication between processes
- Fragile with 10+ patches for tool calling
- No type safety, tight coupling

**V2 is a complete greenfield rewrite** focused on:
- ✅ Production-ready architecture
- ✅ Comprehensive test coverage
- ✅ Modern tooling (Rust-based linters/formatters)
- ✅ Type safety throughout
- ✅ Modular, maintainable codebase

---

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details.

### Quick Contribution Checklist

- [ ] No `any` types - always use proper typing
- [ ] Files under 500 lines (enforced by `npm run check:loc`)
- [ ] Add tests for new features
- [ ] Run `npm run check` before committing
- [ ] Follow existing code patterns

---

## 📄 License

GNU Affero General Public License v3.0 - see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- **[Mastra](https://mastra.ai)** - Multi-provider AI framework
- **[OpenClaw](https://github.com/openclaw/openclaw)** - Architecture inspiration
- **[Electron](https://www.electronjs.org/)** - Cross-platform desktop framework
- **[Papr Memory](https://papr.ai)** - Context-aware memory system

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/Papr-ai/paprwork/issues)
- **Discussions**: [GitHub Discussions](https://github.com/Papr-ai/paprwork/discussions)
- **Documentation**: [docs/](docs/)

---

<div align="center">

**Built with ❤️ using TypeScript, Electron, and Mastra**

[⬆ Back to Top](#-paprwork-v2)

</div>
