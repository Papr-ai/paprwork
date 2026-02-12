# Paprwork V2 Documentation

Comprehensive documentation for Paprwork V2 - AI-powered desktop assistant.

---

## 📁 Documentation Structure

### `/architecture`
System architecture, design decisions, and technical specifications.

**Files:**
- `SYSTEM_OVERVIEW.md` - High-level system architecture
- `CORE_LIBRARY.md` - Shared core library design
- `GATEWAY_ARCHITECTURE.md` - Gateway process architecture
- `IPC_PROTOCOL.md` - Inter-process communication design
- `DATA_FLOW.md` - How data flows through the system

### `/guides`
User and developer guides for getting started and working with the system.

**Files:**
- `GETTING_STARTED.md` - Quick start guide
- `DEVELOPMENT_SETUP.md` - Dev environment setup
- `BUILDING_TOOLS.md` - How to create custom tools
- `TESTING_GUIDE.md` - How to write and run tests
- `DEPLOYMENT.md` - How to build and distribute

### `/api`
API references and specifications.

**Files:**
- `CORE_API.md` - Core library API reference
- `IPC_API.md` - IPC methods and channels
- `TOOL_API.md` - Tool creation API
- `STREAMING_API.md` - Streaming protocol

### `/implementations`
Implementation details for completed features.

**Files:**
- Will be added as features are implemented
- One file per major feature
- Includes rationale, approach, and lessons learned

### `/improvements`
Ideas for future improvements and enhancements.

**Files:**
- Will be added as we identify improvement opportunities
- Tracks potential optimizations and new features

---

## 🔍 Quick Navigation

### For New Developers
1. Read [GETTING_STARTED.md](./guides/GETTING_STARTED.md)
2. Review [SYSTEM_OVERVIEW.md](./architecture/SYSTEM_OVERVIEW.md)
3. Check [DEVELOPMENT_SETUP.md](./guides/DEVELOPMENT_SETUP.md)
4. See [CLAUDE.md](../CLAUDE.md) for project context

### For Tool Development
1. Read [BUILDING_TOOLS.md](./guides/BUILDING_TOOLS.md)
2. Check [TOOL_API.md](./api/TOOL_API.md)
3. See example tools in `src/core/tools/`

### For Architecture Understanding
1. Start with [SYSTEM_OVERVIEW.md](./architecture/SYSTEM_OVERVIEW.md)
2. Read [CORE_LIBRARY.md](./architecture/CORE_LIBRARY.md)
3. Understand [GATEWAY_ARCHITECTURE.md](./architecture/GATEWAY_ARCHITECTURE.md)
4. Review [DATA_FLOW.md](./architecture/DATA_FLOW.md)

---

## 📝 Documentation Standards

### Writing Guidelines
- Use clear, concise language
- Include code examples where relevant
- Keep files focused on one topic
- Update docs when code changes

### File Naming
- Use UPPERCASE for major docs (README.md, CLAUDE.md)
- Use UPPERCASE_WITH_UNDERSCORES for doc files
- Use clear, descriptive names

### Markdown Formatting
- Use proper heading hierarchy (# → ## → ###)
- Include table of contents for long docs
- Use code fences with language tags
- Add images/diagrams where helpful

---

## 🔄 Keeping Docs Updated

**When to update documentation:**
- Adding new features → Update relevant API docs
- Changing architecture → Update architecture docs
- Fixing bugs → Update troubleshooting guides
- Making decisions → Update CLAUDE.md

**Who updates docs:**
- Developers update API/implementation docs
- Architects update architecture docs
- Project leads update CLAUDE.md and plans

---

## 📚 Related Documentation

### Root Level
- [CLAUDE.md](../CLAUDE.md) - Project context and learnings
- [PLAN.md](../PLAN.md) - Implementation timeline
- [README.md](../README.md) - Project overview

### Plans
- [/plans](../plans/) - Detailed feature plans and specifications

### Code
- [/src/core](../src/core/) - Core library with inline documentation
- [/src/main](../src/main/) - Main process implementation
- [/src/gateway](../src/gateway/) - Gateway process implementation

---

## 🎯 Documentation TODOs

- [ ] Write SYSTEM_OVERVIEW.md
- [ ] Write CORE_LIBRARY.md
- [ ] Write GATEWAY_ARCHITECTURE.md
- [ ] Write GETTING_STARTED.md
- [ ] Write DEVELOPMENT_SETUP.md
- [ ] Write BUILDING_TOOLS.md
- [ ] Write IPC_API.md

---

**Last Updated:** 2026-02-09
