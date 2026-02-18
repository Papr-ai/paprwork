# System Prompt Comparison: Paprwork V2 vs V1 vs OpenClaw

**Analysis Date:** 2026-02-16

This document compares the system prompt architectures across three AI agent systems: Paprwork V2, Paprwork V1, and OpenClaw (179k ⭐ open-source project).

---

## 📊 Quick Stats

| Metric | Paprwork V2 | Paprwork V1 | OpenClaw |
|--------|-------------|-------------|----------|
| **Implementation** | TypeScript class | JavaScript class | TypeScript (runtime-generated) |
| **Lines of Code** | 1,098 lines | 1,957 lines | ~200-300 (estimated, dynamically built) |
| **Architecture** | Builder pattern | Builder pattern | Modular sections |
| **File Size** | ~58KB source | ~90KB source | Variable (context-dependent) |
| **Generated Prompt** | ~829 lines | ~1,500+ lines | Variable (38K chars typical) |
| **Prompt Modes** | 2 (full, minimal) | 2 (full, minimal) | 3 (full, minimal, none) |
| **Workspace Injection** | None (yet) | 4 files (MEMORY.md, AGENTS.md, IDENTITY.md, TOOLS.md) | 7 files (BOOTSTRAP.md, HEARTBEAT.md, USER.md, IDENTITY.md, TOOLS.md, SOUL.md, AGENTS.md) |
| **Type Safety** | Strict TypeScript | JavaScript (no types) | Strict TypeScript |

---

## 🏗️ Architectural Comparison

### 1. **Construction Approach**

#### Paprwork V2 ✅
```typescript
class SystemPromptBuilder {
  private options: SystemPromptOptions;
  
  build(): string {
    const sections: string[] = [
      this.buildIdentitySection(),
      this.buildCapabilityMatrixSection(),
      this.buildToolCallStyleSection(),
      this.buildAgentDocsSection(),  // Early positioning
      this.buildSkillsSection(),      // Early positioning
      this.buildApiKeysSection(),
      // ... 30+ more sections
    ];
    
    return sections.filter(Boolean).join('\n\n');
  }
}
```

**Strengths:**
- ✅ **Type-safe**: Every option and section is typed
- ✅ **Modular**: Each section is a separate method
- ✅ **Testable**: Can test individual sections
- ✅ **Early positioning**: Critical docs at top to prevent truncation
- ✅ **Dynamic context**: Loads plans, skills, workspace files on demand

**Weaknesses:**
- ⚠️ **No workspace injection yet**: MEMORY.md, AGENTS.md not loaded
- ⚠️ **Larger codebase**: More lines due to TypeScript strictness

---

#### Paprwork V1 ❌
```javascript
class SystemPromptBuilder {
  async buildPrompt(options = {}) {
    const sections = [];
    
    sections.push(this.buildIdentitySection());
    sections.push(this.buildToolCallStyleSection());
    sections.push(this.buildReferenceDocsSection(agentDocsPath));
    // ... 15+ sections
    
    // Load workspace files (MEMORY.md, AGENTS.md, etc.)
    const workspaceContent = await this.loadWorkspaceFiles();
    if (workspaceContent) {
      sections.push(workspaceContent);
    }
    
    return sections.filter(Boolean).join('\n\n');
  }
}
```

**Strengths:**
- ✅ **Workspace injection**: Loads MEMORY.md, AGENTS.md, IDENTITY.md, TOOLS.md
- ✅ **Daily logs**: Reads today's and yesterday's memory logs
- ✅ **Proven in production**: Used successfully in V1
- ✅ **Comprehensive**: Very detailed sections (1,957 lines)

**Weaknesses:**
- ❌ **No type safety**: Pure JavaScript, any types everywhere
- ❌ **Larger prompt**: Generates much longer prompts (~1,500+ lines)
- ❌ **Less efficient**: More verbose sections
- ❌ **Harder to test**: No type guards or interfaces

---

#### OpenClaw ⚡
```typescript
// OpenClaw builds system prompt dynamically at runtime
// Structure (from docs):
// - Reasoning (visibility level)
// - Runtime (host, OS, model, repo root)
// - Heartbeats (prompt and ack behavior)
// - Reply Tags (provider-specific syntax)
// - Current Date & Time
// - Sandbox (when enabled)
// - Workspace Files (injected)
// - Documentation (local docs path)
// - Workspace (working directory)
// - OpenClaw Self-Update
// - Skills (on-demand loading)
// - Safety (guardrails)
// - Tooling (tools list + descriptions)
```

**Strengths:**
- ✅ **Extremely efficient**: Compact and focused (~38K chars typical)
- ✅ **Skills on-demand**: Only metadata injected, not full skill content
- ✅ **Cache-stable**: Time section is static (no dynamic clock)
- ✅ **Context-aware**: `/context list` and `/context detail` for inspection
- ✅ **Proven at scale**: 179k ⭐, massive user base
- ✅ **Per-file truncation**: Max 20K chars per file with clear markers

**Weaknesses:**
- ⚠️ **Less prescriptive**: Relies more on tool schemas than explicit instructions
- ⚠️ **Simpler features**: No mini-apps, jobs, or agent jobs (different architecture)
- ⚠️ **Less domain-specific**: Generic coding assistant vs. app/automation platform

---

## 🎯 Core Philosophy Differences

### Paprwork V2 & V1: **Prescriptive & Comprehensive**

**Approach:** Teach the agent how to use Paprwork's unique features

**Key Sections:**
- 📱 **Mini-Apps Guide**: Complete HTML/CSS/JS patterns, electronAPI reference
- ⚙️ **Jobs System**: Agent Jobs (AI automation) + Script Jobs (Python/Node/Swift)
- 🗄️ **SQLite Patterns**: Job-to-app data flow, WAL mode, best practices
- 🌐 **Web Access Hierarchy**: curl → native browser → agent-browser (with token cost warnings)
- 🎨 **UI-First Development**: 5-phase protocol for app creation
- 🔑 **API Key Management**: Custom keys, ${KEY_NAME} substitution
- 📦 **Community Apps**: Publishing and installing apps
- 🧠 **Papr Memory**: Semantic search + graph database
- 👥 **Sub-Agents**: Delegation, structured output schemas
- 📊 **Planning**: create_plan, update_plan for multi-step visibility

**Philosophy:** "Here's how to build apps, jobs, and automate workflows in Paprwork"

---

### OpenClaw: **Minimal & Extensible**

**Approach:** Provide core capabilities, let skills handle domain knowledge

**Key Sections:**
- 🛠️ **Tooling**: Concise tools list with schemas (JSON for model)
- 📚 **Skills**: Metadata only, agent reads SKILL.md on-demand
- 🏗️ **Workspace**: Bootstrap files (USER.md, IDENTITY.md, AGENTS.md, SOUL.md)
- 🔒 **Safety**: Advisory guardrails (not enforcement)
- ⏱️ **Time**: Static timezone info (use `session_status` for current time)
- 📖 **Documentation**: Points to local docs directory

**Philosophy:** "Here are your tools, read skills/docs when you need them"

---

## 📋 Feature Comparison Matrix

| Feature | Paprwork V2 | Paprwork V1 | OpenClaw |
|---------|-------------|-------------|----------|
| **Identity Section** | ✅ Includes filesystem access clarification | ✅ CRITICAL OUTPUT RULES | ✅ Basic identity |
| **Tool Call Style** | ✅ Default silent execution | ✅ Narration guidelines | ✅ Implicit in tool schemas |
| **Agent Documentation** | ✅ 7 built-in docs with read_file commands | ✅ 6 reference docs with bash: cat | ✅ Points to local docs folder |
| **Skills System** | ✅ Skill ID + name + description, early positioning | ✅ On-demand loading with bash: cat | ✅ Metadata only, read SKILL.md on-demand |
| **Workspace Injection** | ❌ Not yet (planned) | ✅ 4 files (MEMORY.md, AGENTS.md, IDENTITY.md, TOOLS.md) | ✅ 7 files (BOOTSTRAP, HEARTBEAT, USER, IDENTITY, TOOLS, SOUL, AGENTS) |
| **Memory System** | ✅ Papr Memory (semantic + graph) | ✅ Daily logs (YYYY-MM-DD.md) + MEMORY.md | ❌ Not applicable (different system) |
| **Planning** | ✅ create_plan, update_plan, activePlans in prompt | ✅ create_plan, update_plan | ❌ Not applicable |
| **API Keys** | ✅ ${KEY_NAME} substitution, Settings UI | ✅ ${KEY_NAME} substitution | ✅ Handled via tool policy |
| **Web Access** | ✅ curl → browser hierarchy with token warnings | ✅ curl → browser → agent-browser hierarchy | ✅ exec tool (generic) |
| **Browser Tools** | ✅ Native browser tools (navigate, snapshot, click, type) | ✅ Native browser tools | ✅ browser tool (similar) |
| **Mini-Apps** | ✅ Complete guide, electronAPI reference | ✅ Complete guide, electronAPI reference | ❌ N/A (different architecture) |
| **Jobs** | ✅ Agent Jobs + Script Jobs, job.json patterns | ✅ Agent Jobs + Script Jobs, job.json patterns | ⚠️ Cron-triggered agent turns (ephemeral) |
| **SQLite** | ✅ Built-in, WAL mode, context managers | ✅ Built-in, WAL mode, context managers | ❌ N/A |
| **Sub-Agents** | ✅ delegate_task, structured schemas | ✅ delegate_task, structured schemas | ✅ Nested sub-agents with depth limits |
| **Security** | ✅ Untrusted content rules, injection prevention | ✅ Untrusted content rules, injection prevention | ✅ Advisory safety guardrails |
| **Tool Efficiency** | ✅ 50-iteration budget, loop detection | ✅ 50-iteration budget, loop detection | ⚠️ Provider-dependent |
| **Runtime Info** | ✅ Platform, Node, model, chatId, tools count | ✅ Platform, Node, model, chatId | ✅ Host, OS, Node, model, repo root |
| **Validation Protocol** | ✅ VALIDATION-FIRST (inspect data before processing) | ✅ VALIDATION-FIRST (inspect data before processing) | ⚠️ Implicit in tool usage |
| **UI-First Development** | ✅ 5-phase protocol, mock UI first | ✅ 5-phase protocol, mock UI first | ❌ N/A |
| **Prompt Modes** | ✅ full, minimal | ✅ full, minimal | ✅ full, minimal, none |
| **Context Inspection** | ❌ Not yet | ❌ Not yet | ✅ /context list, /context detail |
| **Compaction** | ❌ Not yet | ❌ Not yet | ✅ /compact command |
| **Time Handling** | ✅ Current date/time in runtime | ✅ Current date/time in runtime | ✅ Static timezone, use session_status |
| **Type Safety** | ✅ Strict TypeScript | ❌ JavaScript | ✅ Strict TypeScript |

---

## 🎨 Design Patterns

### Paprwork V2: **Builder Pattern with Early Positioning**

```typescript
build(): string {
  const staticSections = [
    this.buildIdentitySection(),
    this.buildCapabilityMatrixSection(),
    this.buildToolCallStyleSection(),
    this.buildAgentDocsSection(),  // CRITICAL: Early to prevent truncation
    this.buildSkillsSection(),      // CRITICAL: Early to prevent truncation
    // ... more sections
  ];
  
  const dynamicSections = this.buildDynamicContextSections(history);
  
  return [...staticSections, ...dynamicSections].join('\n\n');
}
```

**Key Innovation:** Critical documentation is positioned early to prevent LLM truncation.

---

### Paprwork V1: **Async Builder with Workspace Loading**

```javascript
async buildPrompt(options = {}) {
  const sections = [];
  
  // Static sections
  sections.push(this.buildIdentitySection());
  // ... more sections
  
  // Load workspace files at the END
  const workspaceContent = await this.loadWorkspaceFiles();
  if (workspaceContent) {
    sections.push(workspaceContent);
  }
  
  return sections.filter(Boolean).join('\n\n');
}
```

**Key Feature:** Workspace files (MEMORY.md, AGENTS.md) injected automatically.

---

### OpenClaw: **Compact with On-Demand Details**

```
System Prompt (38K chars typical):
├── Core Sections (compact)
├── Skills List (metadata only, ~2K chars)
├── Tool Schemas (JSON, ~32K chars)
└── Workspace Files (truncated per-file at 20K chars)

Agent reads skills/docs only when needed.
```

**Key Innovation:** Skills are metadata-only, agent uses `read` tool to load full content on-demand.

---

## 🚀 Performance Comparison

### Token Efficiency

| Metric | Paprwork V2 | Paprwork V1 | OpenClaw |
|--------|-------------|-------------|----------|
| **Base Prompt** | ~829 lines | ~1,500+ lines | ~38K chars (9.6K tokens) |
| **Skills Overhead** | ~100 chars per skill | ~150 chars per skill | ~180 chars per skill (metadata only) |
| **Tool Overhead** | Schemas in registry | Embedded in prompt | Schemas sent as JSON (~32K chars) |
| **Workspace Files** | None yet | 4 files (truncated at 20K each) | 7 files (truncated at 20K each) |
| **Estimated Total** | ~10-12K tokens | ~18-20K tokens | ~15-18K tokens (with bootstrap) |

**Winner for Efficiency:** OpenClaw (smallest base prompt, on-demand skill loading)

---

### Code Maintainability

| Metric | Paprwork V2 | Paprwork V1 | OpenClaw |
|--------|-------------|-------------|----------|
| **Type Safety** | ✅ Strict TypeScript | ❌ JavaScript | ✅ Strict TypeScript |
| **Modularity** | ✅ 30+ small methods | ✅ 15+ methods | ✅ Modular sections |
| **Testability** | ✅ Unit testable sections | ⚠️ Harder to test | ✅ Well-tested (179k ⭐) |
| **Lines of Code** | 1,098 (cleaner) | 1,957 (verbose) | ~200-300 (minimal) |

**Winner for Maintainability:** Paprwork V2 (type-safe, modular, smaller codebase)

---

## 🏆 Strengths & Weaknesses

### Paprwork V2

**Strengths:**
- ✅ **Type-safe**: Strict TypeScript, zero `any` types
- ✅ **Modular**: Small, testable methods
- ✅ **Early positioning**: Critical docs at top to prevent truncation
- ✅ **Dynamic context**: Active plans, skills, workspace files on-demand
- ✅ **Prescriptive**: Detailed guidance on mini-apps, jobs, SQLite
- ✅ **Filesystem access clarity**: Explicit "You Have Full Filesystem Access" section

**Weaknesses:**
- ❌ **No workspace injection yet**: MEMORY.md, AGENTS.md not loaded
- ❌ **No context inspection**: No `/context` command equivalent
- ❌ **No compaction**: No `/compact` command yet
- ⚠️ **More verbose than OpenClaw**: Longer base prompt

**Verdict:** Best for **type safety and domain-specific guidance** (mini-apps, jobs).

---

### Paprwork V1

**Strengths:**
- ✅ **Workspace injection**: MEMORY.md, AGENTS.md, IDENTITY.md, TOOLS.md
- ✅ **Daily logs**: Reads today's and yesterday's memory
- ✅ **Proven in production**: Battle-tested
- ✅ **Comprehensive**: Very detailed (1,957 lines)

**Weaknesses:**
- ❌ **No type safety**: Pure JavaScript
- ❌ **Largest prompt**: ~1,500+ lines generated
- ❌ **Harder to test**: No type guards
- ❌ **Less efficient**: More verbose

**Verdict:** Best for **comprehensive guidance**, but needs TypeScript migration.

---

### OpenClaw

**Strengths:**
- ✅ **Most efficient**: Smallest base prompt (~9.6K tokens)
- ✅ **Skills on-demand**: Metadata only, agent reads when needed
- ✅ **Cache-stable**: Static time section
- ✅ **Context inspection**: `/context list`, `/context detail`
- ✅ **Proven at scale**: 179k ⭐, massive user base
- ✅ **Type-safe**: Strict TypeScript

**Weaknesses:**
- ⚠️ **Less prescriptive**: Relies on skills for domain knowledge
- ⚠️ **Different architecture**: No mini-apps, jobs, SQLite (not applicable)
- ⚠️ **Generic**: Coding assistant, not app/automation platform

**Verdict:** Best for **efficiency and scalability**, but different use case.

---

## 📊 Recommendations for Paprwork V2

### High Priority ✅

1. **Adopt Workspace Injection from V1:**
   - Load MEMORY.md, AGENTS.md, IDENTITY.md, TOOLS.md automatically
   - Read today's and yesterday's daily logs
   - Truncate per-file at 20K chars (OpenClaw pattern)

2. **Adopt On-Demand Skill Loading from OpenClaw:**
   - Keep skill metadata in prompt (id, name, description, path)
   - Agent reads SKILL.md only when needed
   - Reduces base prompt size significantly

3. **Add Context Inspection (OpenClaw pattern):**
   - `/context` command to show prompt sections and sizes
   - `/compact` command for compaction
   - Help users understand token usage

4. **Add Per-File Truncation Markers:**
   - Max 20K chars per workspace file
   - Clear `[... file truncated at 20,000 characters ...]` marker
   - Total bootstrap cap at 150K chars

---

### Medium Priority ⚠️

5. **Cache-Stable Time Section:**
   - Static timezone info in prompt
   - Use tool for current time (avoid prompt changes)

6. **Prompt Mode Refinement:**
   - Add `none` mode (identity line only)
   - Sub-agents only inject AGENTS.md and TOOLS.md (not all files)

7. **Bootstrap File Priority:**
   - Load MEMORY.md first (most important)
   - Then AGENTS.md (user preferences)
   - Then IDENTITY.md, TOOLS.md
   - Skip BOOTSTRAP.md after first run

---

### Low Priority 📝

8. **Sub-Agent Bootstrap Filtering:**
   - Sub-agents only get AGENTS.md and TOOLS.md
   - Main agent gets all files
   - Keeps sub-agent prompts small

9. **Memory File Size Warnings:**
   - Warn if MEMORY.md > 10K chars
   - Suggest compaction/cleanup

10. **Session-Specific Prompts:**
    - Isolate job sessions with minimal prompt
    - Full prompt only for main chat

---

## 🎯 Final Architecture Recommendation

### Best of All Three Worlds

```typescript
class SystemPromptBuilder {
  build(): string {
    // STATIC SECTIONS (always included)
    const staticSections = [
      this.buildIdentitySection(),              // V2: Includes filesystem access
      this.buildCapabilityMatrixSection(),      // V2: Tool capabilities
      this.buildToolCallStyleSection(),         // V1: Narration guidelines
      
      // CRITICAL: Early positioning (V2 innovation)
      this.buildAgentDocsSection(),             // V2: Built-in docs
      this.buildSkillsSection(),                // OpenClaw: Metadata only
      
      this.buildApiKeysSection(),               // V1: Custom keys
      this.buildBashToolSection(),              // V2: Filesystem access
      // ... more sections
    ];
    
    // DYNAMIC SECTIONS (context-dependent)
    const dynamicSections = [
      this.buildActivePlansSection(),           // V2: Current plans
      this.buildWorkspaceInjection(),           // V1: MEMORY.md, AGENTS.md
      this.buildDailyLogsSection(),             // V1: Today's + yesterday's logs
    ];
    
    return [...staticSections, ...dynamicSections].join('\n\n');
  }
  
  // OpenClaw pattern: On-demand skill loading
  buildSkillsSection(): string {
    // Only include metadata (id, name, description, path)
    // Agent reads full SKILL.md when needed
  }
  
  // V1 pattern: Workspace injection
  async buildWorkspaceInjection(): Promise<string> {
    // Load MEMORY.md, AGENTS.md, IDENTITY.md, TOOLS.md
    // Truncate per-file at 20K chars (OpenClaw limit)
    // Total cap at 150K chars
  }
}
```

**Key Innovations:**
- ✅ **V2**: Early positioning, type safety, filesystem clarity
- ✅ **V1**: Workspace injection, daily logs, comprehensive guidance
- ✅ **OpenClaw**: On-demand skills, per-file truncation, efficiency

**Result:** Type-safe, efficient, comprehensive system prompt.

---

## 📈 Implementation Roadmap

### Phase 1: Workspace Injection (Week 1)
```typescript
// Add to SystemPromptBuilder
private async loadWorkspaceFiles(): Promise<string> {
  const files = ['MEMORY.md', 'AGENTS.md', 'IDENTITY.md', 'TOOLS.md'];
  const maxCharsPerFile = 20000;
  const totalMaxChars = 150000;
  
  // Load, truncate, inject
  // Return formatted workspace section
}
```

### Phase 2: On-Demand Skills (Week 2)
```typescript
// Modify buildSkillsSection()
buildSkillsSection(): string {
  // Only include:
  // - Skill ID
  // - Skill name
  // - Skill description
  // - Path to SKILL.md
  
  // Agent uses read_file when needed
}
```

### Phase 3: Context Inspection (Week 3)
```typescript
// Add context inspection tools
export const contextTool = createTool({
  id: 'inspect_context',
  description: 'Show system prompt sections and token usage',
  execute: async () => {
    // Return breakdown of prompt sections and sizes
  }
});
```

### Phase 4: Compaction (Week 4)
```typescript
// Add compaction tool
export const compactTool = createTool({
  id: 'compact_history',
  description: 'Summarize old messages to free context window',
  execute: async () => {
    // Summarize messages, keep recent history
  }
});
```

---

## 🎓 Lessons Learned

### From Paprwork V1
- ✅ Workspace injection is valuable (MEMORY.md, AGENTS.md)
- ✅ Daily logs provide continuity across sessions
- ⚠️ Prompts can get too long (1,500+ lines)
- ⚠️ Type safety matters for maintainability

### From OpenClaw
- ✅ On-demand skill loading is more efficient
- ✅ Per-file truncation prevents context bloat
- ✅ Context inspection helps users understand token usage
- ✅ Cache-stable prompts improve performance
- ⚠️ Generic prompts need domain-specific skills

### For Paprwork V2
- ✅ Type safety is worth the extra code
- ✅ Early positioning prevents truncation
- ✅ Modular sections enable testing
- ⚠️ Need to balance completeness with efficiency
- ⚠️ Workspace injection is critical for continuity

---

## 📝 Conclusion

### System Prompt Ranking

**For Efficiency:** OpenClaw > Paprwork V2 > Paprwork V1
**For Type Safety:** Paprwork V2 = OpenClaw > Paprwork V1
**For Completeness:** Paprwork V1 > Paprwork V2 > OpenClaw
**For Maintainability:** Paprwork V2 > OpenClaw > Paprwork V1

### Recommended Path Forward

**Paprwork V2 should:**
1. ✅ Keep type safety and modular architecture
2. ✅ Adopt workspace injection from V1
3. ✅ Adopt on-demand skill loading from OpenClaw
4. ✅ Add context inspection and compaction
5. ✅ Maintain domain-specific guidance (mini-apps, jobs)

**Result:** Type-safe, efficient, comprehensive system prompt that combines the best of all three systems.

---

**Last Updated:** 2026-02-16
**Version:** 1.0
**Authors:** Paprwork Team
