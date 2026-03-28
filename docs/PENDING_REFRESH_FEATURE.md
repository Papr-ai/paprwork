# Pending Refresh Feature - Non-Disruptive Tab Updates

**Date:** 2026-03-27  
**Issue:** When agent updates a document or app, the tab auto-refreshes and auto-switches, interrupting the user if they're working on a different tab.

---

## Problem

**Before (Disruptive):**
1. User is working on Tab A
2. Agent updates document/app in Tab B
3. Content refresh triggers
4. **Tab auto-switches** to Tab B → interrupts user's workflow
5. User loses focus and context

**User Feedback:** "Gets annoying if the user is doing something on another tab and suddenly gets directed elsewhere."

---

## Solution: Pending Refresh System

**After (Non-Disruptive):**
1. User is working on Tab A
2. Agent updates document/app in Tab B
3. Content refresh is **queued** (not applied immediately)
4. Tab B shows **orange dot indicator** → "Updates available"
5. User continues working on Tab A (no interruption)
6. When user **manually switches** to Tab B → refresh is applied
7. Orange dot clears, user sees updated content

---

## Implementation

### 1. New Tab State: `pendingRefresh`

**File:** `ui/types/tabs.ts`

```typescript
export interface Tab {
  // ...
  isStreaming?: boolean;      // Blue pulsing dot - agent is working
  hasUnread?: boolean;         // Green static dot - streaming finished in bg
  pendingRefresh?: boolean;    // Orange static dot - tab has updates
  // ...
}
```

### 2. Tab Store Methods

**File:** `ui/stores/tabStore.ts`

#### Added `setTabPendingRefresh()`
```typescript
setTabPendingRefresh: (tabId, pending) => {
  const state = get();
  
  // Only set pending if tab is NOT active
  if (tabId === state.activeTabId) {
    return;
  }
  
  set((state) => ({
    tabs: state.tabs.map((t) =>
      t.id === tabId ? { ...t, pendingRefresh: pending } : t,
    ),
  }));
},
```

#### Updated `markTabAsRead()`
Clears pending refresh when user switches to the tab:

```typescript
markTabAsRead: (tabId) => {
  set((state) => ({
    tabs: state.tabs.map((t) =>
      t.id === tabId 
        ? { ...t, hasUnread: false, isStreaming: false, pendingRefresh: false } 
        : t,
    ),
  }));
},
```

#### Updated `addChild()` with `autoSwitch` Option
```typescript
addChild: (parentId, childId, position, options = {}) => {
  const { autoSwitch = true } = options;
  
  // ... existing logic ...
  
  // At the end:
  if (autoSwitch) {
    get().switchToTab(parentId);
  } else {
    // Mark as pending refresh if not auto-switching
    get().setTabPendingRefresh(parentId, true);
  }
},
```

#### Updated `createArtifactFromChat()` with `autoSwitch` Option
```typescript
createArtifactFromChat: (chatTabId, artifactTabId, options = {}) => {
  const { autoSwitch = true } = options;
  // ... delegates to addChild with autoSwitch option
},
```

### 3. Agent Hook: Conditional Auto-Switch

**File:** `ui/hooks/useAgent.ts`

When agent updates a document/app, check if user is on the chat tab:

```typescript
// Check if tab already exists
const existingTabId = `${tabType}-${docId}`;
const chatTabId = `chat-${chatId}`;

// Only auto-switch if user is currently on the chat tab
const isUserOnChatTab = activeTabId === chatTabId;
const autoSwitch = isUserOnChatTab;

if (existingTab) {
  // Refresh with conditional auto-switch
  createArtifactFromChat(chatTabId, existingTabId, { autoSwitch });
} else {
  // Create new tab with conditional auto-switch
  const artifactTabId = createTab(tabType, docId, docTitle || "Artifact");
  createArtifactFromChat(chatTabId, artifactTabId, { autoSwitch });
}
```

**Logic:**
- `autoSwitch: true` → User is on chat tab, safe to switch (they're watching the agent)
- `autoSwitch: false` → User is elsewhere, queue the refresh (don't interrupt)

### 4. Visual Indicator

**File:** `ui/components/Tabs/Tab.tsx`

Added `tab--pending-refresh` class:

```typescript
className={`tab ${isActive ? "tab--active" : ""} 
  ${tab.isStreaming ? "tab--streaming" : ""} 
  ${tab.hasUnread ? "tab--unread" : ""} 
  ${tab.pendingRefresh ? "tab--pending-refresh" : ""}`}
```

**File:** `ui/components/Tabs/Tab.css`

```css
/* Pending refresh indicator (orange static dot) */
.tab.tab--pending-refresh::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 8px;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: #F59E0B; /* Orange */
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  .tab.tab--pending-refresh::before {
    background-color: #FBBF24; /* Lighter orange for dark mode */
  }
}
```

---

## Tab Indicator States

| State | Indicator | Color | Meaning |
|-------|-----------|-------|---------|
| `isStreaming` | Pulsing dot | Blue | Agent is currently working |
| `hasUnread` | Static dot | Green | Streaming finished in background tab |
| `pendingRefresh` | Static dot | Orange | Tab has updates, not yet applied |

---

## User Experience Flow

### Scenario 1: User Watching Agent (No Interruption)
1. User is on Chat Tab A
2. Agent updates doc in Tab B
3. ✅ Tab auto-switches to Tab B (user was watching)
4. User sees the refresh immediately

### Scenario 2: User Working Elsewhere (Non-Disruptive)
1. User is on Chat Tab C
2. Agent updates doc in Tab B
3. ✅ Orange dot appears on Tab B
4. User continues working on Tab C (no interruption)
5. User clicks Tab B when ready
6. ✅ Refresh applied, orange dot clears

### Scenario 3: Multiple Pending Refreshes
1. User is on Tab A
2. Agent updates Tab B → Orange dot
3. Agent updates Tab C → Orange dot
4. User sees both orange dots, knows updates are ready
5. User switches to Tab B → Refresh applied, dot clears
6. User switches to Tab C → Refresh applied, dot clears

---

## Benefits

**Before:**
- ❌ Interrupts user workflow
- ❌ User loses focus and context
- ❌ Frustrating when working on something else
- ❌ No way to know updates happened if you miss the switch

**After:**
- ✅ Non-disruptive (only switches if user is watching)
- ✅ User maintains focus and control
- ✅ Visual indicator shows pending updates
- ✅ User applies refresh when ready
- ✅ Still refreshes immediately when appropriate (user on chat tab)

---

## Edge Cases Handled

### Edge Case 1: User Already on Updated Tab
- `setTabPendingRefresh()` checks if tab is active
- If active, no pending refresh is set (refresh applied immediately via existing view logic)

### Edge Case 2: Manual Tab Switch Clears Pending Refresh
- `switchToTab()` calls `markTabAsRead()` which clears `pendingRefresh`
- User sees fresh content when they click the tab

### Edge Case 3: Multiple Refreshes to Same Tab
- Each refresh attempt checks if user is on the tab
- If not, sets `pendingRefresh: true` (idempotent - no duplicate indicators)
- All pending updates applied when user switches

---

## Testing

### Test Case 1: Agent Updates Tab While User is Watching
1. Open chat, send message to agent
2. Agent updates a document
3. ✅ Tab auto-switches to show document (user was on chat)
4. No orange dot (refresh applied immediately)

### Test Case 2: Agent Updates Tab While User is Elsewhere
1. Open chat, send message to agent
2. Switch to a different tab (e.g., settings)
3. Agent finishes and updates document
4. ✅ Orange dot appears on document tab
5. ✅ User stays on settings tab (no interruption)
6. Click document tab
7. ✅ Refresh applied, orange dot clears

### Test Case 3: Multiple Tabs with Pending Refreshes
1. Agent updates Tab A while user is elsewhere → Orange dot on Tab A
2. Agent updates Tab B while user is elsewhere → Orange dot on Tab B
3. User clicks Tab A → Refresh applied, orange dot clears
4. Tab B still has orange dot
5. User clicks Tab B → Refresh applied, orange dot clears

---

## Files Changed

- `ui/types/tabs.ts` - Added `pendingRefresh?: boolean` to Tab interface
- `ui/stores/tabStore.ts` - Added `setTabPendingRefresh()`, updated `addChild()`, `createArtifactFromChat()`, `markTabAsRead()`
- `ui/hooks/useAgent.ts` - Conditional auto-switch based on active tab
- `ui/components/Tabs/Tab.tsx` - Added `tab--pending-refresh` class
- `ui/components/Tabs/Tab.css` - Orange dot styling for pending refresh
- `docs/PENDING_REFRESH_FEATURE.md` - This documentation

---

## Future Enhancements

### Potential Improvements:
1. **Tooltip on hover:** "Updates available - click to refresh"
2. **Batch refresh button:** "Apply all pending updates" (if many tabs have pending refreshes)
3. **Auto-refresh after timeout:** If user doesn't switch for 5 minutes, auto-apply
4. **Notification:** Toast message "Tab X has updates" with click-to-view action

---

## Migration Notes

**Backward Compatibility:**
- `pendingRefresh` is optional in Tab interface → existing tabs default to `undefined` (falsy)
- `autoSwitch` parameter is optional with default `true` → existing code works unchanged
- All existing auto-switch behavior preserved when user is on the chat tab

**No Breaking Changes:**
- Existing tab management continues to work
- Only adds new non-disruptive behavior
- Visual indicator is purely additive

---

**This feature preserves the refresh capability while making it user-friendly and non-disruptive.**
