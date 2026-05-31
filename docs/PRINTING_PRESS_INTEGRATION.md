# Printing Press Integration Plan

## Overview

Integrate Printing Press's 160+ agent-native CLIs with Paprwork's skill system.

## Architecture Options

### Option 1: Meta-Skill (Recommended)
**Effort**: 5 minutes  
**Maintenance**: Zero

Create ONE skill that teaches agents:
- What Printing Press is
- How to query the live registry
- When to use PP CLIs vs. direct APIs
- Installation and usage patterns

**Pros:**
- Always up-to-date (queries live registry)
- Token-efficient (1 skill vs. 160)
- Agents learn to discover on-demand

**Implementation:**
```bash
# Add to src/resources/skills/printing-press.md
# Already formatted and ready to use
```

---

### Option 2: Auto-Sync System
**Effort**: 1-2 hours  
**Maintenance**: Low (runs automatically)

Periodically fetch `registry.json` and auto-generate skills.

**Implementation:**

#### 1. Create Sync Service

```typescript
// src/gateway/services/PrintingPressSync.ts
export class PrintingPressSyncService {
  private registryUrl = 'https://raw.githubusercontent.com/mvanhorn/printing-press-library/main/registry.json';
  
  async syncRegistry(): Promise<void> {
    const response = await fetch(this.registryUrl);
    const registry = await response.json();
    
    for (const entry of registry.entries) {
      await this.createOrUpdateSkill(entry);
    }
  }
  
  private async createOrUpdateSkill(entry: PPRegistryEntry): Promise<void> {
    const skillContent = this.generateSkillContent(entry);
    const skillId = `pp-${entry.name}`;
    
    // Check if skill exists
    const existing = await skillService.getSkill(skillId);
    if (existing) {
      // Update if registry version is newer
      return;
    }
    
    await skillService.createSkill({
      name: `Printing Press - ${entry.api}`,
      description: entry.description,
      content: skillContent,
      source: 'printing-press',
      externalId: entry.name,
    });
  }
  
  private generateSkillContent(entry: PPRegistryEntry): string {
    return `
# ${entry.api} CLI

${entry.description}

## Installation
\`\`\`bash
npx -y @mvanhorn/printing-press install ${entry.name}
\`\`\`

## Usage
\`\`\`bash
pp-${entry.name} --help
\`\`\`

## Category
${entry.category}

${entry.mcp ? `## MCP Server Available
This CLI includes an MCP server with ${entry.mcp.tool_count} tools.
Auth: ${entry.mcp.auth_type}
${entry.mcp.env_vars.length > 0 ? `Required env vars: ${entry.mcp.env_vars.join(', ')}` : ''}
` : ''}

## Full Documentation
https://github.com/mvanhorn/printing-press-library/tree/main/${entry.path}
`;
  }
}
```

#### 2. Add Sync Job

```typescript
// In gateway initialization or as a scheduled job
const syncService = new PrintingPressSyncService();

// Sync weekly
cron.schedule('0 0 * * 0', async () => {
  await syncService.syncRegistry();
  console.log('[PrintingPress] Registry synced');
});
```

#### 3. UI Enhancement

Add a "Sync Printing Press" button in the Skills UI:
```typescript
// ui/components/Skills/SkillsView.tsx
<button onClick={handleSyncPrintingPress}>
  Sync Printing Press CLIs
</button>
```

**Pros:**
- Individual skills per CLI
- Can assign specific CLIs to specific agents
- Users can enable/disable per CLI
- Richer metadata per tool

**Cons:**
- 160 skills in the UI (could be overwhelming)
- Need to maintain sync logic
- Slightly more complexity

---

### Option 3: Hybrid Approach
**Effort**: 30 minutes  
**Best of both worlds**

1. **Meta-skill** (always included) teaches the ecosystem
2. **Auto-generated category skills** for popular categories:
   - `printing-press-developer-tools.md` (aggregates Docker, GitHub, PyPI CLIs)
   - `printing-press-productivity.md` (Notion, Slack, Cal.com)
   - `printing-press-commerce.md` (Shopify, Amazon, FedEx)

**Implementation:**
```typescript
async syncCategories(): Promise<void> {
  const registry = await this.fetchRegistry();
  const byCategory = this.groupByCategory(registry.entries);
  
  for (const [category, entries] of Object.entries(byCategory)) {
    const skillContent = this.generateCategorySkill(category, entries);
    await skillService.createSkill({
      name: `Printing Press - ${category}`,
      description: `${entries.length} CLIs for ${category}`,
      content: skillContent,
    });
  }
}
```

**Result:**
- 1 meta-skill + ~12 category skills (manageable)
- Agents load only relevant categories
- Still stays in sync with live registry

---

## Recommendation

**Start with Option 1 (Meta-Skill)**:
1. Takes 5 minutes
2. Zero maintenance
3. Always up-to-date
4. Agents learn to be autonomous

**Later, add Option 3** if users want:
- Easier CLI assignment to specific agents
- Richer per-category guidance
- Better UI organization

---

## Next Steps

1. Create `src/resources/skills/printing-press.md` (meta-skill)
2. Test with agent: "Can you help me find a CLI for tracking Linear issues?"
3. Monitor usage patterns
4. Add category skills if needed

## Implementation Timeline

- **Phase 1** (Today): Meta-skill → 5 min
- **Phase 2** (Week 1): Category skills → 30 min  
- **Phase 3** (Week 2): Auto-sync system → 2 hours
