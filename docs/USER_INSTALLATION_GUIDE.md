# User Installation Guide - What You Need

**Last Updated:** 2026-04-12

This guide explains what's included in the Paprwork app and what prerequisites users need.

---

## 📦 For End Users (Downloading Packaged App)

### ✅ What's Included (Nothing to Install!)

The packaged app (DMG/PKG for Mac, EXE for Windows, AppImage/DEB for Linux) includes **EVERYTHING** you need:

- **Electron Runtime** - Built-in, no separate install needed
- **Node.js** - Embedded in Electron (v24.13.0)
- **All JavaScript/TypeScript Dependencies** - Pre-bundled in the app
- **React UI** - Pre-built and included
- **Gateway Process** - Included
- **Core Tools** - All built-in

**Users download and run. That's it.** ✅

### 🐍 Python Dependencies (Auto-Install)

**For browser HTML parsing features:**
- **BeautifulSoup4** - Auto-installs silently in background on first launch
- **lxml** - Auto-installs silently in background on first launch

**What users see:** Nothing! Installation happens automatically with zero user interaction.

**If Python is not installed:**
- Browser HTML parsing tools won't work
- Agent will detect missing Python and offer to install it (guided process)
- Everything else works fine without Python

### 📋 Optional: What Users Might Want

These are **optional** and only needed for specific features:

| Feature | Requirement | Auto-Install? | Impact if Missing |
|---------|-------------|---------------|-------------------|
| **Python Jobs** | Python 3.x | ❌ No (agent offers to install) | Can't create Python-based automation jobs |
| **Node Jobs** | Already included ✅ | N/A | Always works |
| **Git Operations** | Git CLI | ❌ No (agent offers to install) | Can't use git auto-staging, version control features |
| **Ollama (Local AI)** | Ollama binary | ✅ Yes (electron-ollama auto-downloads) | Can't use free local AI models |

---

## 👨‍💻 For Developers (Running from Source)

### Required Prerequisites

1. **Node.js v24+**
   ```bash
   # Install via nvm (recommended)
   nvm install 24
   nvm use 24
   
   # Or download from nodejs.org
   # https://nodejs.org/en/download/
   ```

2. **npm v10+** (comes with Node.js)

3. **Git** (to clone the repository)

### Installation Steps

```bash
# 1. Clone the repository
git clone https://github.com/Papr-ai/paprwork.git
cd paprwork

# 2. Use Node v24
nvm use 24

# 3. Install dependencies (auto-installs UI workspace too)
npm install

# 4. Configure environment
cp .env.example .env.local
# Edit .env.local with your API keys

# 5. Start the app
npm start
```

### Optional Development Tools

These improve the development experience but aren't required:

- **oxlint** - 50-100x faster linting (auto-installed via npm)
- **oxfmt** - 30x faster formatting (auto-installed via npm)
- **Rust** - Only if you want to modify Rust tools (not needed for normal development)

---

## 🔧 Agent Auto-Installation Features

Paprwork's agent can automatically install missing tools when needed:

### 1. Python
**When needed:** User tries to create Python job or use Python tools

**Agent behavior:**
```
Agent: "I notice Python is not installed. May I install it for you? (Takes ~2-3 minutes)"
User: "Yes please"
Agent: [Runs platform-specific install command]
# Windows: winget install Python.Python.3.12
# macOS:   brew install python3
# Linux:   sudo apt install python3
Agent: "Python 3.12.8 installed successfully! Now creating your job..."
```

### 2. Node.js (if somehow missing)
**When needed:** User tries to create Node job

**Agent behavior:**
```
Agent: "Node.js not found. May I install it? (Takes ~1-2 minutes)"
User: "Yes"
Agent: [Runs platform-specific install]
# Windows: winget install OpenJS.NodeJS.LTS
# macOS:   brew install node
# Linux:   sudo apt install nodejs npm
```

### 3. Git (optional but recommended)
**When needed:** Agent creates files and wants to auto-stage them

**Agent behavior:**
```
Agent: "Git not installed - file auto-staging disabled. Install Git? (Takes ~1 minute)"
User: "Sure"
Agent: [Runs platform-specific install]
```

### 4. Python Dependencies (BeautifulSoup4, lxml)
**When needed:** Browser HTML parsing tools used

**Agent behavior:**
- **Completely silent** - installs in background with zero user interaction
- Detects virtualenv vs system Python automatically
- Uses correct install command (with/without `--user` flag)
- Only logs to console for debugging

**Users see:** Nothing! Just works. ✅

### 5. Ollama (Local AI)
**When needed:** User selects Ollama model

**Agent behavior:**
- `electron-ollama` auto-downloads Ollama binary (~50MB)
- Downloads selected model (2-17GB depending on model size)
- Shows progress bar with download status
- **No manual installation needed**

---

## 🎯 Summary by User Type

### Non-Technical User (Downloaded App)
**Prerequisites:** None ✅
**Experience:** Download → Double-click → Works
**Optional features:** Agent will offer to install Python/Git if needed

### Technical User (Downloaded App)
**Prerequisites:** None ✅
**Experience:** Same as non-technical, but can manually install optional tools if preferred

### Developer (Running from Source)
**Prerequisites:** Node.js v24+, npm, Git
**Experience:** Clone → npm install → npm start
**Optional:** Python, Rust tools (for advanced features)

---

## ❓ FAQ

### Q: Do I need to install npm to use Paprwork?
**A:** No! Only developers running from source need npm. The downloaded app includes everything.

### Q: What if I don't have Python?
**A:** Most features work without Python. For Python-specific features, the agent will offer to install it for you.

### Q: Can I use Paprwork offline?
**A:** Yes! Download Ollama models for completely local AI inference (no internet required after model download).

### Q: What about custom API keys?
**A:** Optional. You can use Paprwork with:
1. Papr account (recommended for non-technical users) - auto-provisions keys
2. Your own OpenAI/Anthropic/Google API keys
3. Ollama (free, local, no API keys needed)

### Q: Do I need Papr Memory for the app to work?
**A:** No! Papr Memory is optional. The app works fully without it. Papr Memory adds:
- Cloud-synced context across devices
- Semantic search capabilities
- Enhanced long-term memory

---

## 🚀 Recommended Setup for Non-Technical Users

1. **Download packaged app** (DMG/EXE/AppImage)
2. **Double-click to install**
3. **Sign in with Papr** (optional but recommended - auto-provisions API keys)
4. **Start chatting** - Everything else auto-installs as needed!

**That's it!** No technical knowledge required. ✅

---

## 📦 What's in the Packaged App?

The packaged app is a single self-contained bundle:

```
PaprWork.app (macOS) / PaprWork.exe (Windows) / PaprWork.AppImage (Linux)
├── Electron Runtime (~200MB)
├── Node.js v24.13.0 (embedded)
├── All npm dependencies (pre-bundled)
├── React UI (pre-built)
├── Gateway process
├── Core tools & utilities
└── Default resources (agent docs, skills)
```

**Total size:** ~300-400MB (includes Electron + Chromium + Node.js + all dependencies)

**No external dependencies.** It just works. ✅

---

## 🔄 Update Process

**Auto-updates enabled:**
- App checks for updates on startup
- Downloads updates in background
- Prompts user when ready to install
- **Zero manual intervention needed**

**Users never need to:**
- Run `npm install` again
- Update Node.js manually
- Reinstall dependencies
- Build anything

**Just restart the app when prompted!** ✅
