---
id: preloaded-systematic-debugging
name: Systematic Debugging
description: Structured debugging methodology — reproduce, isolate, hypothesize, verify, and document fixes.
---
# Systematic Debugging

A structured approach to finding and fixing bugs efficiently.

## The Process

### Step 1: Reproduce
Before anything else, reliably reproduce the bug:
- Get exact steps to trigger the issue
- Note the environment (OS, versions, configuration)
- Confirm: "Does this happen every time or intermittently?"

### Step 2: Isolate
Narrow down the scope:
- When did it last work? (git bisect if needed)
- Does it happen in a minimal reproduction?
- Which component/layer is involved?

### Step 3: Hypothesize
Form 2-3 hypotheses about the root cause:
- "The issue is likely in X because Y"
- Rank by probability
- Design a test for the most likely hypothesis

### Step 4: Verify
Test each hypothesis systematically:
```bash
# Add logging at key points
# Check intermediate state
# Compare expected vs actual values
# Use debugger breakpoints
```

### Step 5: Fix
- Make the minimal change that fixes the root cause
- Don't fix symptoms — fix the underlying issue
- Consider: "Could this same class of bug exist elsewhere?"

### Step 6: Document
- What was the bug?
- What was the root cause?
- What was the fix?
- How to prevent similar bugs?

## Common Debugging Techniques

### Binary Search (git bisect)
```bash
git bisect start
git bisect bad           # Current commit is broken
git bisect good abc123   # This commit was working
# Git checks out middle, you test, repeat
```

### Logging Strategy
```
[ENTRY] Function called with args: {...}
[STATE] Variable X = value at checkpoint
[EXIT] Function returned: {...}
[ERROR] Unexpected state: expected X, got Y
```

### Rubber Duck Method
Explain the code line by line. Often the bug reveals itself when you articulate what should happen vs what actually happens.

## Anti-patterns

- **Shotgun debugging**: Making random changes hoping something works
- **Print-and-pray**: Adding print statements without a hypothesis
- **Blame the framework**: Assuming the bug is in the library before checking your code
- **Fix the symptom**: Wrapping in try/catch without understanding why it throws

## When to Escalate

If you've spent more than 30 minutes without progress:
1. Summarize what you've tried
2. Share the reproduction steps
3. Ask for a fresh perspective
4. Consider if the bug reveals a design flaw
