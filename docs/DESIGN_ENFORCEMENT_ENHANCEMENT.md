# Design Enforcement Enhancement

**Added:** 2026-04-08
**Problem:** Agent creates busy, cluttered mini-apps with "dashboard soup" (too many cards) instead of clean, focused designs matching the Liquid Glass aesthetic
**Solution:** Enhanced SystemPrompt with explicit anti-patterns, stronger design system enforcement, and visual examples of what NOT to do

---

## The Problem

Users reported that agents were creating mini-apps with:
- **Dashboard soup:** 5-8+ cards on one screen with no visual hierarchy
- **Busy layouts:** Cramped spacing, no breathing room
- **Multiple primary actions:** 3-4 competing buttons
- **Inconsistent design:** Not following Liquid Glass aesthetic

This happened even though:
- Design system skill exists (`preloaded-paprwork-design-system`)
- Design philosophy section exists in SystemPrompt
- Critical rule says to load design system before UI work

**Root cause:** The anti-patterns were only documented in the design skill file, not reinforced in the main SystemPrompt. Agents could skip reading the skill and create designs from memory/intuition.

---

## The Solution

Enhanced three sections of SystemPrompt to explicitly call out bad designs:

### 1. Enhanced Critical Rules

**Before:**
```
4. BEFORE creating or editing any UI/frontend code, load the design system
```

**After:**
```
4. BEFORE creating or editing any UI/frontend code, load the design system
5. NEVER create "dashboard soup" — if you're adding 5+ cards to one screen, 
   redesign with 2-3 focused sections instead
```

### 2. Expanded Product Design Philosophy Section

**Before:** Brief bullet points about focus and simplicity (5 principles)

**After:** Comprehensive guide with:
- Core principles (unchanged)
- **NEW: ANTI-PATTERNS section** with explicit examples:
  - ❌ Dashboard Soup (too many cards)
  - ❌ Multiple Primary Actions
  - ❌ Busy Layouts (cramped spacing)
  - ❌ Hidden Critical Actions
- **NEW: "BEFORE YOU CREATE ANY UI" checklist**
- **NEW: Visual Style Checklist** (what to do ✅ vs avoid ❌)

### 3. Strengthened Design System Loading Section

**Before:**
```
The design system defines:
- Liquid Glass visual identity
- Component patterns
- Layout principles
- Button states, form patterns, card styles

If you skip this, you WILL create inconsistent, off-brand designs.
```

**After:**
```
The design system defines:
- Liquid Glass visual identity
- Component patterns
- Layout principles
- Button states, form patterns, card styles
- ANTI-PATTERNS: Dashboard soup, multiple primary actions, cramped layouts

If you skip this, you WILL create:
- ❌ Dashboard soup (too many cards, no hierarchy)
- ❌ Busy layouts with cramped spacing
- ❌ Multiple competing primary buttons
- ❌ Inconsistent, off-brand designs

The design system teaches you to create:
- ✅ Clean, spacious layouts (2-3 focused sections)
- ✅ ONE primary action per screen
- ✅ Generous whitespace and visual hierarchy
- ✅ Liquid Glass aesthetic (translucent, premium feel)

Load it every time. No exceptions.
```

---

## What Changed

### New Anti-Patterns Documentation (in SystemPrompt)

**❌ Dashboard Soup:**
- Definition: Too many cards/modules with no visual hierarchy
- Red flag: If creating 5+ cards on one screen
- Solution: Prefer 2-3 focused sections over 6+ tiny cards

**❌ Multiple Primary Actions:**
- Definition: When everything is important, nothing is
- Rule: Only ONE primary button per screen
- Solution: Secondary actions use ghost/outline buttons or links

**❌ Busy Layouts:**
- Definition: Dense grids, cramped spacing, no breathing room
- Solution: Use generous whitespace (24-48px between major sections)
- Prefer: Vertical single-column layouts over multi-column grids

**❌ Hidden Critical Actions:**
- Definition: Important features buried in menus
- Rule: Primary action must be visible without scrolling

### New Design Checklist (in SystemPrompt)

**BEFORE YOU CREATE ANY UI:**
1. Load the design skill: `read_skill({ skillId: "preloaded-paprwork-design-system" })`
2. Define the ONE job this screen does
3. Identify the ONE primary action
4. Design with 2-3 focused sections maximum
5. Use the Liquid Glass tokens from the design system

**Visual Style Checklist:**
- ✅ Clean, spacious layouts with generous padding
- ✅ 2-3 focused sections (not 6+ cards)
- ✅ ONE dominant primary button
- ✅ Liquid Glass aesthetic (translucent surfaces, subtle borders)
- ✅ System fonts, consistent spacing, design tokens
- ❌ NO dashboard soup, NO competing CTAs, NO cramped grids

---

## Expected Impact

### Before (Observed Problems)
- Agent creates 6-8 cards on one screen
- Multiple "primary" buttons competing for attention
- Cramped spacing (8-12px between sections)
- Generic grid layouts with no visual hierarchy
- Skips loading design system ("I already know the patterns")

### After (Expected Behavior)
- Agent loads design system skill FIRST
- Creates 2-3 focused sections maximum
- ONE clear primary action per screen
- Generous whitespace (24-48px between major sections)
- Follows Liquid Glass aesthetic from design system
- If tempted to add 5th card → stops and redesigns

---

## Testing Checklist

To verify the enhancement is working, test these scenarios:

### Test 1: Create Analytics Dashboard
```
User: "Create an analytics dashboard showing sales, revenue, customers, 
       orders, conversion rate, and top products"
```

**Expected:**
1. Agent loads design system skill first
2. Creates 2-3 focused sections:
   - Hero metrics (2-3 key numbers)
   - Main chart/table (primary insight)
   - Optional: Secondary view or filters
3. ONE primary action (e.g., "Export Report", "View Details")
4. Generous spacing, Liquid Glass aesthetic

**Red flags:**
- 6+ individual cards for each metric
- Multiple primary buttons
- Cramped grid layout
- Skips loading design system

### Test 2: Create Task Manager
```
User: "Build a task manager with inbox, today, upcoming, projects, 
       tags, priorities, and search"
```

**Expected:**
1. Agent loads design system skill first
2. Simplifies to ONE main view (e.g., "Today" or "Inbox")
3. Other views accessible via navigation (not all on one screen)
4. ONE primary action ("Add Task")
5. Clean, focused layout

**Red flags:**
- All 7 sections on one screen
- Multiple primary "Add" buttons
- Busy sidebar with all filters visible
- No clear visual hierarchy

### Test 3: Update Existing App
```
User: "Add more metrics to the sales dashboard"
```

**Expected:**
1. Agent loads design system skill first
2. Checks existing layout (how many sections?)
3. If already 3 sections → suggests redesign instead of adding 4th
4. If adds metrics → groups them logically (doesn't add more cards)

**Red flags:**
- Blindly adds 3 more cards without checking layout
- Creates 6+ total cards
- Doesn't consider visual hierarchy

---

## Files Changed

### Modified
- `src/core/agents/SystemPrompt.ts`
  - Enhanced Critical Rules (added rule #5)
  - Expanded Product Design Philosophy section
  - Strengthened design system loading section

### Created
- `docs/DESIGN_ENFORCEMENT_ENHANCEMENT.md` - This file

---

## Design System Skill (Unchanged)

The `preloaded-paprwork-design-system` skill already had these anti-patterns documented. The enhancement brings them into the SystemPrompt so agents see them WITHOUT having to load the skill first (though they should still load it).

**From design system skill:**
```markdown
### Anti-patterns (do not ship)
- "Dashboard soup" (too many modules, no priority)
- Multiple primary buttons competing for attention
- Hidden critical actions behind menus
- Heavy gradients, loud shadows, or decorative motion
- Asking users to configure everything before first success
```

---

## Success Metrics

**Quantitative:**
- % of apps with 2-3 sections (target: >80%)
- % of apps with only 1 primary button (target: >90%)
- % of apps that load design system skill (target: 100%)

**Qualitative:**
- Apps feel "Apple-like" (clean, obvious, premium)
- Users can identify the primary action within 2 seconds
- No more comments about "too busy" or "cluttered" designs

---

## Future Enhancements

1. **Automated validation:** Script that analyzes app HTML/CSS and flags:
   - More than 3 `.card` or `.section` elements
   - More than 1 `.btn-primary` button
   - Missing design system tokens
   - Cramped spacing (padding <16px)

2. **Design system templates:** Pre-built layouts for common patterns:
   - `template-analytics.html` (2 metrics cards + 1 chart)
   - `template-inbox.html` (single-column list + 1 CTA)
   - `template-settings.html` (form sections)

3. **Plan enforcement for apps:** Require agents to create a design plan BEFORE creating any UI:
   - What's the ONE job?
   - What's the ONE primary action?
   - What are the 2-3 sections?

4. **Visual linter in CI:** Reject app submissions that violate design rules

---

## Conclusion

This enhancement makes the design guidance **impossible to miss**. The anti-patterns are now documented in THREE places:
1. Critical Rules (top of SystemPrompt)
2. Product Design Philosophy section (detailed examples)
3. Design System Loading section (consequences of skipping)

Plus the existing design system skill (which agents should still load).

**Pattern:** Moving from "optional best practice" → "hard requirement with explicit examples"

Agents should now consistently create clean, focused designs that match the Liquid Glass aesthetic, with 2-3 sections maximum, ONE primary action, and generous spacing.
