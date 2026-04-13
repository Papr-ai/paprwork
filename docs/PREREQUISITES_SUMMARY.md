# Prerequisites Summary - Quick Reference

## 📦 End Users (Downloading Packaged App)

### ✅ Included (Zero Setup)
- Electron runtime
- Node.js (embedded)
- All JavaScript dependencies
- React UI (pre-built)
- All core tools

### 🤖 Auto-Installs (Silent, No User Action)
- **BeautifulSoup4** - For HTML parsing
- **lxml** - For faster parsing
- **Ollama** - For local AI models (if selected)

### 🛠️ Agent-Assisted Install (When Needed)
- **Python** - If user creates Python jobs or uses Python tools
- **Git** - If user wants version control features
- **Other packages** - Agent offers to install as needed

### ❌ NOT Required
- ❌ Node.js (embedded in app)
- ❌ npm (not needed)
- ❌ Git (optional, agent can install)
- ❌ Python (optional, agent can install)
- ❌ Technical knowledge

**TL;DR: Download → Run → Done. Everything else auto-installs as needed.**

---

## 👨‍💻 Developers (Running from Source)

### ✅ Required
- Node.js v24+
- npm v10+
- Git (to clone repo)

### 🔧 Auto-Installed via npm
- All JavaScript dependencies
- oxlint (Rust-based linter)
- oxfmt (Rust-based formatter)
- TypeScript compiler
- All UI dependencies (via workspaces)

### ❌ NOT Required
- ❌ Rust (unless modifying Rust tools)
- ❌ Python (unless testing Python features)
- ❌ Docker
- ❌ Database setup (SQLite is file-based)

**TL;DR: Just Node.js v24+. Everything else via `npm install`.**

---

## 🎯 Feature-Specific Requirements

| Feature | Packaged App | From Source | Notes |
|---------|--------------|-------------|-------|
| **Basic Chat** | ✅ Included | ✅ Included | Always works |
| **Browser Tools** | ✅ Auto-installs | ✅ Auto-installs | BeautifulSoup4/lxml |
| **Python Jobs** | Agent assists | Needs Python | Agent offers to install |
| **Node Jobs** | ✅ Included | ✅ Included | Always works |
| **Git Auto-Stage** | Agent assists | Needs Git | Agent offers to install |
| **Ollama (Local AI)** | ✅ Auto-downloads | ✅ Auto-downloads | electron-ollama |
| **Papr Memory** | Optional | Optional | Cloud-based, needs account |

---

## 🚀 Installation Commands

### End Users
```bash
# macOS
open PaprWork-2.0.0.pkg

# Windows
./PaprWork-Setup-2.0.0.exe

# Linux
chmod +x PaprWork-2.0.0.AppImage
./PaprWork-2.0.0.AppImage
```

### Developers
```bash
git clone https://github.com/Papr-ai/paprwork.git
cd paprwork
nvm use 24
npm install
npm start
```

---

## ✨ Key Insight

**For 95% of users:** Just download and run. The app handles everything else automatically.

**For developers:** Just Node.js v24. Everything else via npm.

**No complex setup. No technical knowledge needed. It just works.** ✅
