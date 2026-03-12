# Design System Loading Enforcement

**Date:** 2026-03-09
**Issue:** Agent creates UI without loading the design system, resulting in inconsistent styling

---

## Problem

When agents create or edit mini-apps, they sometimes skip loading the Paprwork Design System skill, resulting in:

1. **Inconsistent styling** - Not following Liquid Glass visual identity
2. **Wrong colors/typography** - Using generic styles instead of design tokens
3. **Poor component patterns** - Reinventing components that have established patterns
4. **Missing states** - Buttons without loading states, forms without validation UX
5. **Layout issues** - Not following spacing/grid principles

## Why This Matters

The **Paprwork Design System** (`preloaded-paprwork-design-system`) defines:

- **Liquid Glass visual identity** - Colors, typography, spacing that make Paprwork feel premium
- **Component architecture** - Buttons, cards, forms, modals with proper states
- **Layout principles** - Grid system, responsive patterns, content hierarchy
- **Best practices** - TypeScript patterns, accessibility, performance

**Without loading this skill**, agents create generic-looking UIs that:
- Don't match the Paprwork aesthetic
- Require rework to align with design standards
- Create technical debt (inconsistent code patterns)
- Hurt user experience (missing states, poor UX)

---

## Solution: Multi-Layer Enforcement

### 1. Capability Matrix - Rule #4

**Location:** `src/core/agents/SystemPrompt.ts` → `buildCapabilityMatrixSection()`

**Added:**
```typescript
## Critical Rules

1. If a capability is not enabled, do NOT claim it exists.
2. Prefer first-party tools over raw bash when a dedicated tool exists.
3. For multi-step automation, choose an architecture (job + data + mini-app) before implementation.
4. **BEFORE creating or editing any UI/frontend code, load the design system:** `read_skill({ skillId: "preloaded-paprwork-design-system" })`
```

**Why:** First mention - sets expectation early that design system is required.

### 2. App Creation Reminder - Rule #4

**Location:** `src/core/agents/SystemPrompt.ts` → `buildAppCreationReminderSection()`

**Added:**
```typescript
**4. CRITICAL: Load Design System for Frontend Work:**
`read_skill({ skillId: "preloaded-paprwork-design-system" })` — REQUIRED before creating or editing any UI/frontend code (mini-apps, components, styling). This includes:
- Creating new mini-apps (`create_app`)
- Editing app HTML/CSS/TypeScript files
- Updating UI components
- Styling work
- Any visual/frontend changes

**The design system defines:**
- Liquid Glass visual identity (colors, typography, spacing)
- Component patterns and best practices
- Layout principles and responsive design
- Button states, form patterns, card styles

**Don't build UI without it** - you'll create inconsistent designs that don't match the Paprwork aesthetic.
```

**Why:** 
- **Explicit about scope** - Lists exactly when to load it
- **Shows value** - Explains what's in the design system
- **Strong language** - "REQUIRED", "Don't build UI without it"

### 3. Workflow Order

**Added to workflow sequence:**
```
1. Load design system (if UI work) → 2. Load app guide → 3. Create plan → 4. Check existing apps → 5. Start work → 6. Update plan after each step
```

**Why:** Shows the design system as **first step** for UI work, before even creating the plan.

---

## When Design System Should Be Loaded

### ✅ Always Load For:

1. **Creating mini-apps**
   ```javascript
   read_skill({ skillId: "preloaded-paprwork-design-system" })
   create_app({ name: "Dashboard", files: [...] })
   ```

2. **Editing app files**
   ```javascript
   read_skill({ skillId: "preloaded-paprwork-design-system" })
   edit_app_file({ appId: "...", filename: "app.ts", content: "..." })
   ```

3. **Updating styling**
   ```javascript
   read_skill({ skillId: "preloaded-paprwork-design-system" })
   edit_app_file({ appId: "...", filename: "style.css", content: "..." })
   ```

4. **Component work**
   - Adding buttons
   - Creating forms
   - Building cards
   - Modal dialogs
   - Any visual component

### ❌ Don't Need For:

1. **Backend-only work**
   - Creating Python/Node jobs
   - Writing bash scripts
   - Database schema changes (if not affecting UI)

2. **Data operations**
   - Reading files
   - Running queries
   - Processing data

3. **Non-UI tools**
   - Browser automation
   - API calls
   - File system operations

---

## Example Workflows

### Creating a Mini-App

**Correct:**
```
1. read_skill({ skillId: "preloaded-paprwork-design-system" })  ← Load design system FIRST
2. read_skill({ skillId: "preloaded-app-and-jobs-guide" })       ← Then app guide
3. create_plan({ title: "Build Dashboard", steps: [...] })       ← Then plan
4. create_app({ name: "Dashboard", files: [...] })               ← Then build
```

**Wrong:**
```
1. create_app({ name: "Dashboard", files: [...] })  ← Missing design system!
```

### Updating App Styling

**Correct:**
```
1. read_skill({ skillId: "preloaded-paprwork-design-system" })  ← Load design system
2. read_app_file({ appId: "...", filename: "style.css" })       ← Read current
3. edit_app_file({ appId: "...", filename: "style.css", content: "..." })  ← Update
```

**Wrong:**
```
1. edit_app_file({ appId: "...", filename: "style.css", content: "..." })  ← Missing design system!
```

---

## Testing Strategy

### Monitor for:

1. **`create_app` without prior `read_skill` call**
   - Check agent conversation logs
   - Should see `read_skill({ skillId: "preloaded-paprwork-design-system" })` before `create_app`

2. **Styling inconsistencies**
   - Apps not using Liquid Glass colors
   - Typography not matching design system
   - Components missing proper states

3. **Generic UI patterns**
   - Plain buttons instead of Liquid Glass button styles
   - Forms without validation UX
   - Cards without proper spacing/shadows

### Success Metrics:

- **100% of UI work** starts with design system load
- **Reduced rework** - Apps match design standards first time
- **Consistent aesthetic** - All mini-apps feel cohesive
- **Better UX** - Proper states, loading indicators, error handling

---

## Benefits

### 1. Consistent User Experience
All mini-apps have the same:
- Visual identity (Liquid Glass)
- Component behavior (button states, form validation)
- Layout principles (spacing, grid, responsive)

### 2. Reduced Rework
Agent builds it right the first time:
- No need to go back and "make it look like Paprwork"
- Fewer iterations on styling
- Less time spent on UI polish

### 3. Better Code Quality
Following established patterns:
- TypeScript component architecture
- Proper state management
- Accessibility built-in
- Performance best practices

### 4. Faster Development
Don't reinvent the wheel:
- Use proven component patterns
- Follow layout guidelines
- Apply design tokens (colors, spacing)

---

## Related Changes

This is part of a larger system prompt improvement effort:

1. **API Keys in Jobs** - Explicit guidance on `${KEY_NAME}` substitution
2. **Incremental Plan Updates** - Update after each step, not at end
3. **Plan Tool Retries** - Only call `create_plan` once
4. **Design System Loading** - This change

All aimed at making agent behavior more predictable and aligned with best practices.

---

## Files Changed

1. **`src/core/agents/SystemPrompt.ts`**
   - Added design system requirement to Capability Matrix (Rule #4)
   - Added detailed section in App Creation Reminder (Rule #4)
   - Updated workflow order to include design system as first step

---

## Future Enhancements

### 1. Automatic Check
Add validation in `create_app` tool:
```typescript
// Check if design system was loaded in recent tool calls
const recentTools = getRecentToolCalls(5);
const designSystemLoaded = recentTools.some(
  tc => tc.toolName === 'read_skill' && 
        tc.args?.skillId === 'preloaded-paprwork-design-system'
);

if (!designSystemLoaded) {
  console.warn('⚠️ Design system not loaded - UI may be inconsistent');
}
```

### 2. Skill Dependencies
Mark design system as dependency in app guide skill:
```yaml
dependencies:
  - preloaded-paprwork-design-system
```

When loading app guide, automatically suggest design system if UI work detected.

### 3. UI Linting
Add checks in dev tools:
- Validate color values match design tokens
- Check spacing values align with grid
- Ensure button classes follow patterns

---

## Monitoring

After deployment, track:

1. **Design system load rate** - % of app creation workflows that load it
2. **Consistency score** - Manual review of generated UIs for design alignment
3. **Rework frequency** - How often apps need styling fixes post-creation
4. **Time to completion** - Does loading design system speed up overall workflow?

Expected improvements:
- Design system load rate: 0% → 95%+
- Rework frequency: High → Low
- Time to completion: Faster (less iteration)
- Consistency score: Higher
