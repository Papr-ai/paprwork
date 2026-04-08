# First Launch Experience - User Journey

## What Users See on Fresh Installation

When users install and launch Paprwork for the first time with **no existing content**, they see:

### 1. Initial Loading (< 1 second)
```
Loading preferences and app state...
```

### 2. Getting Started Tab (Full-Screen Onboarding)

The app automatically opens a **"Getting Started"** tab showing a beautiful full-screen onboarding experience:

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│              [Papr Logo]                                │
│                                                         │
│         Welcome to Paprwork!                            │
│     Let's get you set up in 3 quick steps              │
│                                                         │
│  ┌──────────────────────────────────────────────┐     │
│  │  ⭐ Recommended                               │     │
│  │  [Login with Papr]                           │     │
│  │  Get automatic Papr Memory access            │     │
│  │  Or skip and add API keys manually below     │     │
│  └──────────────────────────────────────────────┘     │
│                                                         │
│  ✅ Step 1: Connect ChatGPT, Claude, or your keys     │
│     Sign in with ChatGPT or Claude if you have a      │
│     subscription, or add your own API keys            │
│                                                         │
│  🔒 Step 2: Setup Your Agents                          │
│     Tell us about your work (unlocks after step 1)    │
│                                                         │
│  🔒 Step 3: Complete First Task                        │
│     Try your first task or build an app               │
│                                                         │
│  Start here: Use step 1 to open Settings              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 3. Sidebar - Onboarding Card

The **sidebar footer** also shows a compact onboarding progress card:

```
┌─────────────────────────────┐
│ Getting started      [0/3]  │
│ ▼                            │
│                              │
│ 🔒 Step 1: Settings          │
│    Connect accounts          │
│                              │
│ 🔒 Step 2: Setup             │
│    Tell us about you         │
│                              │
│ 🔒 Step 3: First Task        │
│    Get started              │
└─────────────────────────────┘
```

### 4. Background - Home Dashboard Ready

Behind the scenes, the app has **already installed** the default home dashboard:
- ✅ App files copied to `~/Papr/apps/{id}/`
- ✅ App registered in `~/Papr/data/apps.json`
- ✅ Default home app set in settings
- ✅ Ready to open when user clicks home button

## User Journey Flow

### Step 1: Connect Accounts (Active)
**User clicks "Step 1"** → Opens Settings

**Options shown:**
1. **Papr Login (Recommended)**
   - One-click OAuth → Automatic Papr Memory access
   - Auto-provisions API key
   - Auto-marks step 1 complete ✅

2. **ChatGPT Plus/Pro OAuth**
   - Sign in with existing subscription
   - Uses subscription models (no API costs)

3. **Claude Pro/Max OAuth**
   - Sign in with existing subscription
   - Uses subscription models (no API costs)

4. **Manual API Keys**
   - OpenAI API key
   - Anthropic API key
   - Google AI API key

**After completing:** Step 1 ✅ unlocks Step 2

### Step 2: Setup Your Agents (Unlocks after Step 1)
**User clicks "Step 2"** → Opens new chat with pre-filled message:
```
"Let's get started with onboarding! I'd like you to learn about me and set things up."
```

**Agent behavior:**
- Asks about user's work
- Learns about workflows
- Configures sub-agents
- Sets up initial preferences

**After chatting:** Step 2 ✅ unlocks Step 3

### Step 3: Complete First Task (Unlocks after Step 2)
**User clicks "Step 3"** → Opens new chat with pre-filled message:
```
"Based on what you learned about me, help me with my first task or create an app that would be most useful for my work."
```

**Agent behavior:**
- Suggests relevant first task based on user's work
- OR offers to build a custom dashboard app
- Demonstrates capabilities

**After completion:** Step 3 ✅

### Auto-Dismiss (All Steps Complete)
When all 3 steps are complete:
- Getting Started tab auto-closes after 1.5 seconds
- Onboarding card collapses to minimal state
- User can click "Open Getting Started" to reopen if needed

## What Happens After Onboarding

### 1. Home Button Works
**User clicks home button** → Opens the bundled home dashboard
- Shows "Home" in tab title
- Displays "Your daily command center" dashboard
- Shows meetings, priorities, OKRs, action items
- Powered by overnight agent collaboration

### 2. Clean Slate
- No pre-created chats (starts fresh)
- No jobs yet (user creates as needed)
- No apps yet (except default home dashboard)
- Sidebar shows:
  - Recent chats (empty)
  - Favorites (empty)
  - Onboarding card (collapsed)

### 3. User Can Start
- **Start a new chat** - Cmd+N or click "New Chat"
- **Explore settings** - Click Settings icon
- **Check home dashboard** - Click home button
- **Browse apps** - Click Apps icon (shows home dashboard)

## Edge Cases

### No API Keys/OAuth Connected
**After dismissing onboarding without completing Step 1:**
- App still works
- User sees "No model configured" when trying to chat
- Sidebar onboarding card remains visible (not dismissed)
- User can reopen Getting Started at any time

### Commercial Build (REQUIRE_PAPR_AUTH=true)
**Before onboarding:**
- Shows authentication wall
- Blocks all access until user logs in with Papr
- After login → Shows onboarding as normal

### Open Source Build (Default)
**Onboarding is optional:**
- User can dismiss without completing
- All features accessible
- Papr login recommended but not required

## Onboarding Persistence

### LocalStorage Keys
```javascript
papr-onboarding-dismissed: "true"    // User dismissed onboarding
papr-onboarding-step1: "true"        // Step 1 completed
papr-onboarding-step2: "true"        // Step 2 completed  
papr-onboarding-step3: "true"        // Step 3 completed
```

### State Management
- Progress synced across:
  - Getting Started tab (full-screen view)
  - Sidebar onboarding card (compact view)
- Changes trigger `papr-onboarding-changed` event
- Both components listen and update in real-time

### Reopening Onboarding
**User can always reopen:**
1. Click "Open Getting Started" link in sidebar card
2. Cmd+K → search "Getting Started" → Enter
3. Sidebar → Click "Getting Started" in recent

## Design Philosophy

### 1. **Non-Blocking**
- Onboarding is a separate tab (not a modal)
- User can dismiss and explore freely
- Can come back anytime

### 2. **Progressive**
- Steps unlock sequentially (prevents confusion)
- Each step builds on previous
- Clear progress indicators

### 3. **Guided but Flexible**
- Recommended path (Papr login → setup → first task)
- Alternative paths (manual API keys, skip steps)
- No forced actions

### 4. **Instant Value**
- Home dashboard already installed
- Ready to use immediately after Step 1
- Agent can start helping right away

## Technical Implementation

### Onboarding Trigger
```typescript
// App.tsx - Lines 149-175
const checkOnboarding = () => {
  const dismissed = localStorage.getItem("papr-onboarding-dismissed") === "true";
  const step1 = localStorage.getItem("papr-onboarding-step1") === "true";
  const step2 = localStorage.getItem("papr-onboarding-step2") === "true";
  const step3 = localStorage.getItem("papr-onboarding-step3") === "true";
  
  // Show getting started tab if not dismissed and no steps completed
  const shouldShow = !dismissed && !step1 && !step2 && !step3;
  
  if (shouldShow) {
    createTab('getting-started', 'default', 'Getting Started');
  }
};
```

### Step Completion
```typescript
// OnboardingView.tsx - Step handlers
handleStepClick(1) → openSettings() → Auto-mark complete after 1s
handleStepClick(2) → sendInNewChat("setup message") → Auto-mark complete after 2s
handleStepClick(3) → sendInNewChat("first task message") → Auto-mark complete after 2s
```

### Auto-Dismiss
```typescript
// OnboardingView.tsx - Lines 80-93
useEffect(() => {
  if (step1 && step2 && step3) {
    setTimeout(() => {
      localStorage.setItem("papr-onboarding-dismissed", "true");
      window.dispatchEvent(new CustomEvent("papr-onboarding-changed"));
    }, 1500); // 1.5 second delay
  }
}, [state]);
```

## Metrics to Track

**Onboarding Completion:**
- % users who complete Step 1 (connect accounts)
- % users who complete Step 2 (setup)
- % users who complete Step 3 (first task)
- Time to complete each step
- Drop-off points

**First Actions:**
- Time to first chat message
- Time to first app creation
- Time to first job creation
- % users who click home button

**Retention:**
- Day 1 retention (came back next day)
- Week 1 retention
- Correlation: onboarding completion → retention

## Future Improvements

1. **Personalized onboarding** based on user's work type
2. **Video walkthroughs** for each step
3. **Interactive tutorials** (do it with the agent)
4. **Skip options** for power users
5. **Onboarding analytics** dashboard
6. **A/B testing** different onboarding flows

---

**Summary:** Fresh installations show a beautiful, progressive 3-step onboarding that guides users from zero to productive in minutes, with the home dashboard ready to go as soon as they connect an account.
