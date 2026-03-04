# Why Ollama Downloads Take Time

**Last Updated:** 2026-03-03

## Overview

When users select a Qwen model for the first time, they may experience a longer-than-expected download time. This document explains **why** and **what improvements we've made** to clarify the process.

---

## The Two-Phase Download Process

### Phase 1: Ollama Binary Installation (First Time Only)
**What happens:**
- The `electron-ollama` package downloads the **entire Ollama application** for your platform
- This is a one-time setup that happens automatically

**Download sizes by platform:**
- **macOS:** ~400-500MB (includes both Intel and Apple Silicon binaries)
- **Windows:** ~300-400MB
- **Linux:** ~200-300MB

**Duration:**
- **Fast internet (100 Mbps):** 30 seconds - 2 minutes
- **Average internet (25 Mbps):** 2-5 minutes
- **Slow internet (5 Mbps):** 5-10 minutes

**User visibility:**
- Previously: **No feedback** - users saw "Downloading qwen3.5:2b... 0%" stuck at 0%
- Now: **Clear message** - "Installing Ollama (first time setup)..." with animated progress bar

### Phase 2: Model Download (Every New Model)
**What happens:**
- Ollama downloads the actual AI model files

**Model sizes:**
- `qwen3.5:0.8b` → ~500MB
- `qwen3.5:2b` → ~1.3GB
- `qwen3.5:4b` → ~2.7GB
- `qwen3.5:latest` (9B) → ~5.4GB ⭐ Recommended
- `qwen3.5:27b` → ~17GB

**Duration (9B model on different speeds):**
- **Fast internet (100 Mbps):** 5-7 minutes
- **Average internet (25 Mbps):** 15-20 minutes
- **Slow internet (5 Mbps):** 60-90 minutes

**User visibility:**
- Shows actual download progress: "Downloading qwen3.5:latest... 45%"

---

## Total First-Time Experience

**Example: User selects Qwen 3.5 9B on average internet (25 Mbps)**

```
Time 0:00 → "Installing Ollama (first time setup)..."
              [Animated progress bar]
Time 3:00 → "Downloading qwen3.5:latest... 0%"
Time 5:00 → "Downloading qwen3.5:latest... 15%"
Time 10:00 → "Downloading qwen3.5:latest... 50%"
Time 15:00 → "Downloading qwen3.5:latest... 85%"
Time 18:00 → "Extracting qwen3.5:latest... 100%"
Time 18:30 → ✅ Ready to chat!

TOTAL: ~18-20 minutes
```

**Subsequent model selections:**
- Skip Phase 1 (Ollama already installed)
- Only download the new model (Phase 2)
- Much faster!

---

## What We Changed to Improve UX

### Before (Confusing Experience)
```
User sees: "Downloading qwen3.5:2b... 0%"
What's happening: Installing Ollama silently
User thinks: "Is it stuck? Is it broken?"
Result: User waits with no feedback for 3-5 minutes
```

### After (Clear Experience)
```
User sees: "Installing Ollama (first time setup)..."
            [Smooth animated progress bar]
What's happening: Installing Ollama with visual feedback
User thinks: "Ah, it's installing something. I'll wait."
Result: User understands what's happening

Then: "Downloading qwen3.5:2b... 15%"
      "Downloading qwen3.5:2b... 50%"
      "Downloading qwen3.5:2b... 100%"
User sees actual progress!
```

---

## Implementation Details

### Backend Changes (`OllamaManager.ts`)

```typescript
async start(onProgress?: (message: string) => void): Promise<boolean> {
  if (onProgress) {
    onProgress('Installing Ollama (this may take a few minutes)...');
  }
  
  await this.ollama.serve(metadata.version, {
    serverLog: (message: string) => {
      console.log('[Ollama]', message);
      if (onProgress && message.includes('Downloading')) {
        onProgress(`Installing Ollama: ${message}`);
      }
    },
    // NEW: Track Ollama binary download progress
    downloadLog: (percent: number, message: string) => {
      console.log(`[Ollama Download] ${percent}%: ${message}`);
      if (onProgress) {
        onProgress(`Installing Ollama: ${Math.round(percent)}%`);
      }
    },
  });
}
```

### Frontend Changes (`ChatContainer.tsx`)

```tsx
{progress && progress.status !== 'complete' && (
  <div className="ollama-progress-banner">
    <span className="progress-text">
      {progress.percent === 0 
        ? `Installing Ollama (first time setup)...`  // Phase 1
        : progress.status === 'downloading' 
          ? `Downloading ${progress.modelName}...`    // Phase 2
          : `Extracting ${progress.modelName}...`     // Phase 2 (final)
      }
    </span>
    <div className="progress-bar">
      <div 
        className="progress-bar-fill" 
        style={{ 
          width: progress.percent === 0 ? '100%' : `${progress.percent}%`,
          // Animated when percent is 0 (indeterminate)
          animation: progress.percent === 0 ? 'indeterminate 2s infinite' : 'none'
        }}
      />
    </div>
    {progress.percent > 0 && (
      <span className="progress-percent">{progress.percent}%</span>
    )}
  </div>
)}
```

### CSS Animation (Indeterminate Progress)

```css
@keyframes indeterminate {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(400%);
  }
}
```

---

## Why We Can't Skip This

**Q: Can't we bundle Ollama with the app?**

A: Not practically:
- Ollama binaries are **~400MB** per platform
- Supporting all platforms (macOS Intel, macOS ARM, Windows, Linux) = **~1.5GB**
- Users would download 1.5GB even if they never use on-device AI
- Better UX: Auto-install only when user chooses Qwen

**Q: Can we make it faster?**

A: We're already doing the fastest approach:
- Using `electron-ollama` (proven, maintained, efficient)
- Showing clear progress feedback
- Downloading in parallel when possible
- No unnecessary steps

The download speed is limited by:
1. User's internet speed (we can't control)
2. Ollama binary size (~400MB, necessary)
3. Model size (1-17GB, user's choice)

---

## User Recommendations

### For Best Experience

1. **Choose the right model for your device:**
   - 8GB RAM → `qwen3.5:2b` (fast download, good performance)
   - 16GB RAM → `qwen3.5:latest` (9B) ⭐ **Recommended**
   - 32GB+ RAM → `qwen3.5:27b` (best quality, long download)

2. **Wait through the first download:**
   - First model: 15-20 minutes (includes Ollama setup)
   - Subsequent models: 5-15 minutes (just model download)
   - **Worth it:** Unlimited on-device AI with no API costs!

3. **Use other chats while downloading:**
   - Ollama download doesn't block other chats
   - Use Claude/GPT-5 in other chats while Qwen downloads

---

## Related Documentation

- [Ollama Setup Guide](./OLLAMA_QWEN_SETUP.md) - How to use Qwen models
- [Qwen Model Selection Guide](./QWEN_MODEL_SELECTION_GUIDE.md) - Which model to choose
- [Ollama Auto-Install Implementation](./OLLAMA_AUTO_INSTALL_IMPLEMENTATION.md) - Technical details

---

## Troubleshooting

### Download stuck at 0%?
- **Old version:** Upgrade to latest Paprwork (includes progress fix)
- **Network issue:** Check your internet connection
- **First time?** Wait 3-5 minutes for Ollama binary installation

### Download taking over 30 minutes?
- Check your internet speed (test at fast.com)
- Consider starting with smaller model (`qwen3.5:2b`)
- Leave app open - download continues in background

### "Installation failed" error?
- Check disk space (need ~20GB free for largest models)
- Restart app and try again
- Check logs in Console for specific error

---

**Key Takeaway:** The download time is necessary to install powerful on-device AI. We've made the process **as clear and user-friendly as possible** with transparent progress tracking for both phases.
