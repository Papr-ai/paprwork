# Auto-Scroll Behavior for Streaming Content

## Overview

The MessageList component now intelligently auto-scrolls to show new content as the agent streams thinking tokens, tool calls, and responses.

## How It Works

### 1. **Auto-Scroll Triggers**

Auto-scroll activates on:
- ✅ **New messages** - User or assistant messages
- ✅ **Streaming text** - Agent typing response
- ✅ **Thinking tokens** - Agent reasoning (💭)
- ✅ **Tool calls** - New tool execution starts
- ✅ **Tool results** - Tool completion updates

### 2. **User Scroll Detection**

The system respects user intent:

```
User scrolled up to read history?
  → Auto-scroll DISABLED

User scrolled back to bottom (< 100px from bottom)?
  → Auto-scroll RE-ENABLED
```

**Why 100px threshold?**
- Gives user control without being too sensitive
- Small movements near bottom don't disable auto-scroll
- Intentional scroll-up (reading history) disables it

### 3. **Performance Optimization**

**Two-stage approach:**

#### **Stage 1: Major Changes** (useLayoutEffect)
```typescript
// Runs when messages array changes
// Before browser paint (no visible jump)
useLayoutEffect(() => {
  if (content grew && auto-scroll enabled) {
    scroll to bottom instantly
  }
}, [messages, activeRequest, isLoading]);
```

#### **Stage 2: Streaming Updates** (useEffect + RAF)
```typescript
// Runs on EVERY render when streaming
// Catches thinking tokens, tool calls, text deltas
useEffect(() => {
  if (any message is streaming) {
    requestAnimationFrame(() => {
      scroll to bottom smoothly
    })
  }
}); // No deps - intentionally runs every render
```

**Why requestAnimationFrame?**
- Batches rapid scroll updates (thinking tokens stream fast)
- Smooth 60fps scrolling
- Prevents scroll jank
- Browser-optimized timing

---

## User Experience

### **Scenario 1: Agent Thinking**

```
Agent message appears:
┌─ Extended Thinking ─────────────────────┐
│ 💭 Analyzing the code structure...      │
└──────────────────────────────────────────┘
↓ (auto-scrolls)

New thinking tokens arrive:
┌─ Extended Thinking ─────────────────────┐
│ 💭 Analyzing the code structure...      │
│ Let me scan the files to understand...  │
└──────────────────────────────────────────┘
↓ (auto-scrolls smoothly)

More thinking:
┌─ Extended Thinking ─────────────────────┐
│ 💭 Analyzing the code structure...      │
│ Let me scan the files to understand...  │
│ I notice there are 50 TypeScript files  │
└──────────────────────────────────────────┘
↓ (auto-scrolls smoothly)
```

**User sees**: Thinking content continuously visible, no manual scrolling needed

### **Scenario 2: Tool Calls**

```
First tool call starts:
┌─ Exploring ──────────────────────────────┐
│ 🔧 bash: npm test                        │
│    Status: ⏳ calling                     │
└───────────────────────────────────────────┘
↓ (auto-scrolls)

Second tool call starts:
┌─ Exploring ──────────────────────────────┐
│ 🔧 bash: npm test                        │
│    Status: ⏳ calling                     │
│                                           │
│ 🔧 filesystem: Reading package.json      │
│    Status: ⏳ calling                     │
└───────────────────────────────────────────┘
↓ (auto-scrolls)

Tool completes:
┌─ Exploring ──────────────────────────────┐
│ 🔧 bash: npm test                        │
│    Status: ✓ success                     │
│    Result: All tests passed              │
│                                           │
│ 🔧 filesystem: Reading package.json      │
│    Status: ⏳ calling                     │
└───────────────────────────────────────────┘
↓ (auto-scrolls)
```

**User sees**: All tool activity visible without scrolling

### **Scenario 3: Agent Typing Response**

```
Agent starts typing:
"I've analyzed the code▊"
↓ (auto-scrolls)

More text arrives:
"I've analyzed the code and found 
several opportunities for improvement▊"
↓ (auto-scrolls)

Full response:
"I've analyzed the code and found 
several opportunities for improvement:

1. Use async/await instead of callbacks
2. Add type annotations
3. Extract reusable functions▊"
↓ (auto-scrolls)
```

**User sees**: Response streams into view continuously

### **Scenario 4: User Reading History**

```
User scrolls up to read previous messages:
[Scroll up 500px]

Auto-scroll: DISABLED ✋

Agent continues streaming below:
(new thinking tokens arrive)
(new tool calls appear)
(new text streams)

User stays at their scroll position ✓
```

**User sees**: Position maintained while reading history

```
User scrolls back to bottom:
[Scroll down to < 100px from bottom]

Auto-scroll: RE-ENABLED ✅

Agent streaming:
(new content appears)
↓ (auto-scrolls resume)
```

**User sees**: Auto-scroll resumes when they return to bottom

---

## Technical Details

### **Why useEffect without dependencies?**

```typescript
useEffect(() => {
  // Runs on EVERY render
  if (hasStreamingMessage) {
    requestAnimationFrame(scrollToBottom);
  }
});
```

**Reasoning:**
- Streaming content updates don't change `messages` array reference
- State updates happen inside existing message objects
- Need to catch every render to see new thinking/tool content
- RAF prevents performance issues from rapid calls

### **Performance Characteristics**

| Event | Trigger | Method | Performance |
|-------|---------|--------|-------------|
| New message | Array change | useLayoutEffect | Instant (pre-paint) |
| Thinking token | Render | useEffect + RAF | Smooth (60fps) |
| Tool call | Render | useEffect + RAF | Smooth (60fps) |
| Text delta | Render | useEffect + RAF | Smooth (60fps) |
| User scroll | Scroll event | Event listener | No impact |

**Result**: Butter-smooth scrolling even with rapid updates

---

## Edge Cases Handled

### **1. Rapid Thinking Tokens (100+ per second)**
```typescript
requestAnimationFrame(() => scroll);
// Browser batches updates at 60fps
// No scroll jank!
```

### **2. User Scrolls During Streaming**
```typescript
distanceFromBottom > 100px
→ autoScrollEnabled = false
→ No interruption
```

### **3. Multiple Tool Calls at Once**
```typescript
Each tool call updates content height
→ useEffect detects change
→ Scrolls to show all tools
```

### **4. Very Long Thinking Text**
```typescript
Thinking grows to 1000+ lines
→ Height change detected
→ Scrolls to keep cursor visible
```

### **5. Tab Switch During Streaming**
```typescript
Switch away from chat tab
→ Scroll position saved
→ Switch back to tab
→ Auto-scroll resumes if was enabled
```

---

## Code Structure

```typescript
MessageList Component
├── Refs
│   ├── listRef (scroll container)
│   ├── messagesEndRef (scroll anchor)
│   ├── autoScrollEnabled (user preference)
│   └── lastScrollHeight (change detection)
│
├── Effects
│   ├── Scroll Event Listener
│   │   → Detects user scroll position
│   │   → Enables/disables auto-scroll
│   │
│   ├── useLayoutEffect (Major Changes)
│   │   → [messages, activeRequest, isLoading]
│   │   → Instant scroll on message changes
│   │
│   └── useEffect (Streaming Updates)
│       → [] (runs every render)
│       → RAF scroll for streaming content
│
└── Render
    ├── MessageItem (each message)
    │   ├── ThinkingCard (💭)
    │   ├── ExploringCard (🔧)
    │   └── Markdown (text)
    └── Loading indicator
```

---

## Testing Scenarios

### **Test 1: Thinking Tokens**
1. Send message requiring extended thinking
2. Verify scroll follows thinking as it streams
3. Scroll up manually
4. Verify thinking continues but scroll stays put
5. Scroll back to bottom
6. Verify auto-scroll resumes

**Expected**: ✅ Smooth follow during streaming, respects user scroll position

### **Test 2: Multiple Tool Calls**
1. Send message that triggers 10+ tool calls
2. Verify scroll shows each new tool as it starts
3. Verify scroll updates as tools complete
4. Check no scroll jank with rapid tool updates

**Expected**: ✅ All tool activity visible, smooth scrolling

### **Test 3: Very Long Response**
1. Send message that generates 1000+ line response
2. Verify scroll keeps cursor visible throughout
3. Check no performance issues during long stream
4. Verify final scroll position is at bottom

**Expected**: ✅ Continuous visibility, no lag

### **Test 4: User Interaction**
1. Start streaming response
2. Scroll up to read history
3. Verify auto-scroll stops
4. Let stream complete
5. Verify scroll position unchanged
6. Scroll back to bottom
7. Send new message
8. Verify auto-scroll works again

**Expected**: ✅ User intent respected, auto-scroll resumes when appropriate

---

## Comparison: Before vs After

| Scenario | Before | After |
|----------|--------|-------|
| **Thinking tokens** | ❌ Stay scrolled to first line | ✅ Follow thinking as it streams |
| **Tool calls** | ❌ Only scroll on new message | ✅ Scroll for each new tool |
| **Tool results** | ❌ Miss result if scrolled up | ✅ See result if at bottom |
| **Long responses** | ❌ Cursor scrolls off-screen | ✅ Cursor always visible |
| **User reading** | ✅ Position maintained | ✅ Position maintained |
| **Performance** | ✅ Good | ✅ Good (RAF optimized) |

---

## Future Enhancements

### **1. Smart Scroll Toggle**
```
[🔒 Scroll Locked] ← User manually scrolled up
Click to unlock and jump to latest content
```

### **2. "New Content" Indicator**
```
↓ 23 new lines below ↓
Click to jump to bottom
```

### **3. Scroll Position Memory**
```
Remember scroll position per chat
Restore when switching back to tab
```

### **4. Smooth Scroll Animation**
```
Optional smooth scrolling (instead of instant)
For users who prefer animation
```

---

## Summary

The improved auto-scroll system:

✅ **Tracks all streaming content** - thinking, tools, text
✅ **Respects user intent** - disables when scrolling history  
✅ **Smooth performance** - RAF-optimized, no jank
✅ **Smart re-enable** - resumes when user returns to bottom
✅ **Works with long-running agents** - hours of streaming content

**User experience**: "It just works" - content always visible during streaming, manual control when reading history. 🎯
