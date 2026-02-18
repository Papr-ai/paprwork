# Agents Page: V1 vs V2 Feature Gaps

## Overview
This document outlines the differences between Paprwork V1 and V2 Agents pages, identifying missing features and architectural differences.

---

## Missing from V2 (Present in V1)

### 1. **Tools Configuration Card**
- **V1 Location:** Marketplace section
- **Description:** Card for managing which tools agents can access
- **Action:** Opens Tools Manager dialog
- **Status:** ❌ Not in V2

### 2. **Pen Agent Metrics**
V1 shows comprehensive main agent metrics:
- **Words Generated** (with session count)
- **Tool Calls** (with unique tools count)  
- **Total Time** (with thinking/actioning breakdown)
- **Top Tools Bar Chart** (top 5 tools by call count)
- **Skills Tags** (visual tags for active skills)

V2 shows delegation-focused metrics instead:
- Delegation Runs
- Completed
- Failed
- Specialists

**Status:** ❌ V1 metrics not in V2

### 3. **Overview Stats**
V1 has:
- Words Generated
- Tool Calls
- Total Time
- Skills Used
- Active Agents

V2 has:
- Active Agents
- Total Delegations
- Success Rate
- Running Now
- Skills Used

**Status:** ⚠️ Different focus (V1 = main agent activity, V2 = delegation metrics)

### 4. **Activity Timeline Data Source**
- **V1:** Shows main agent chat sessions with words generated, tool calls, duration
- **V2:** Shows delegation runs with agent ID, task, status
- **Status:** ⚠️ Different data model

### 5. **Stat Card Icons**
- **V1:** Colorful SVG icons for each stat
- **V2:** No icons, text only
- **Status:** ❌ Icons missing

### 6. **Marketplace Card Icons**
- **V1:** Gradient icon blocks for Skills/Tools/Create cards
- **V2:** Plain text only
- **Status:** ❌ Icons missing

### 7. **Tool/Skill Overflow Badges**
- **V1:** Shows "+N" badges when tools/skills exceed display limit
- **V2:** Truncates without overflow indicator
- **Status:** ❌ Overflow badges missing

### 8. **Dynamic Model Selector**
- **V1:** Loads available models from settings API, grouped by provider, shows API key status
- **V2:** Static hardcoded model list
- **Status:** ⚠️ Less dynamic

### 9. **Empty State Actions**
- **V1:** "Configure Agents" button when no specialists exist
- **V2:** No action button
- **Status:** ❌ Missing

---

## New in V2 (Not in V1)

### 1. **Recent Conversations Section**
- Shows last 10 chats sorted by update time
- Displays chat title and timestamp
- **Status:** ✅ New feature

### 2. **Delegation-Focused Metrics**
- Success Rate percentage
- Running Now count
- Total Delegations count
- **Status:** ✅ New architecture

### 3. **Model Selector on Specialist Cards**
- Inline dropdown to change specialist model
- **Status:** ✅ (Also in V1 component version)

### 4. **Jobs Card in Marketplace**
- Replaces Tools Configuration in V1 standalone
- **Status:** ✅ New feature

---

## Layout Differences

| Aspect | V1 | V2 | Status |
|--------|----|----|--------|
| Max width | 1400px | ~~1400px~~ → **100%** | ✅ Fixed |
| Padding | 32px / 24px | 24px | ✅ Same |
| Section spacing | 48px / 40px | 32px | ⚠️ Tighter |
| Stat cards grid | auto-fit, 200-240px | auto-fit, 220px | ✅ Similar |
| Specialist grid | auto-fill, 300px | auto-fill, 300px | ✅ Same |
| Activity timeline | Horizontal dots | Vertical with connector | ⚠️ Different style |

---

## Functional Differences

### Time Formatting
- **V1:** Relative times ("2h ago", "5m ago")
- **V2:** Absolute times (`toLocaleString()`)
- **Impact:** Less intuitive

### Property Names
- **V1:** `allowedTools`, `assignedSkills`
- **V2:** `allowedToolIds`, `assignedSkills`
- **Impact:** API compatibility

### Refresh Interval
- **V1:** 30 seconds
- **V2:** 15 seconds
- **Impact:** More frequent updates

### Avatar Style
- **V1:** SVG layers icon
- **V2:** Emoji "✒️"
- **Impact:** Visual consistency

---

## Recommendations

### High Priority
1. ✅ **Fix full-width layout** - Remove max-width constraint
2. ⚠️ **Add stat card icons** - Improve visual hierarchy
3. ⚠️ **Add marketplace card icons** - Match V1 design
4. ⚠️ **Show overflow badges** - Better UX for tool/skill lists

### Medium Priority
5. ⚠️ **Consider hybrid metrics** - Show both main agent and delegation stats
6. ⚠️ **Add Tools Configuration card** - Or integrate into Settings
7. ⚠️ **Use relative time formatting** - More user-friendly
8. ⚠️ **Add empty state actions** - Guide users to configure

### Low Priority
9. ⚠️ **Dynamic model loading** - Load from settings API
10. ⚠️ **Vertical timeline styling** - Match V1 horizontal style (optional)

---

## Current Status

### ✅ Completed
- Full-width layout (removed max-width constraint)
- Model selector in create modal
- Custom system prompt field in create modal

### 🚧 In Progress
- None

### ⏳ Planned
- See recommendations above

---

**Last Updated:** 2026-02-16
