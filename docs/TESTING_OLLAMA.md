# Testing Ollama Auto-Install

## ✅ Verification Steps

### 1. App Starts Successfully
**Status:** ✅ PASS
- App launches without errors
- Ollama Manager initialized: `/Users/amirkabbara/Library/Application Support/Papr Work/ollama`
- IPC handlers registered

### 2. Select Qwen Model (First Time)
**Steps to test:**
1. Open Paprwork
2. Click model picker (current model badge in input)
3. Scroll to "Ollama (On-Device)" section
4. Click "Qwen 3.5 2B" (recommended for testing - 2.7GB)

**Expected behavior:**
- Purple progress banner appears: "Downloading qwen3.5:2b..."
- Progress bar shows percentage (0% → 100%)
- Status changes: "Downloading" → "Extracting" → Complete
- Input disabled with "Preparing model..." placeholder
- When complete, banner disappears, model ready to use

### 3. Chat with Qwen Model
**Steps:**
1. Type a message: "Hello! Can you tell me about yourself?"
2. Send message

**Expected:**
- Message streams back from local Qwen model
- Response generated 100% on-device
- No API calls to cloud services

### 4. Select Qwen Model (Second Time)
**Steps:**
1. Switch to different model (e.g., Claude)
2. Switch back to "Qwen 3.5 2B"

**Expected:**
- No download (model already installed)
- Model immediately available
- Input not disabled (instant)

### 5. Check Ollama Status
**Manual verification:**
```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# Should return JSON with installed models
# Example: {"models": [{"name": "qwen3.5:2b", ...}]}
```

## 🐛 Known Issues to Watch For

### Issue 1: Ollama Already Running
**Symptom:** App detects existing Ollama instance
**Expected:** App uses existing installation (good!)
**Log:** `[OllamaManager] Ollama already running (existing installation)`

### Issue 2: Download Interrupted
**Symptom:** Progress bar stops, error in console
**Solution:** Retry model selection (should resume or restart)

### Issue 3: Port 11434 in Use
**Symptom:** Can't start Ollama
**Solution:** Kill existing process: `pkill ollama`

## 📊 Success Metrics

✅ **Zero Manual Setup** - No terminal commands needed
✅ **Progress Visibility** - User sees what's happening
✅ **Graceful Degradation** - Uses existing Ollama if present
✅ **Error Handling** - Clear messages if something fails
✅ **Privacy** - All inference on-device

## 🎯 Test Checklist

- [ ] App starts without errors
- [ ] Ollama models visible in picker
- [ ] First-time download works with progress
- [ ] Progress bar updates smoothly
- [ ] Model ready after download
- [ ] Chat works with Qwen model
- [ ] Second selection is instant (no re-download)
- [ ] Can switch between cloud and local models
- [ ] App cleanup on quit (Ollama continues if manually installed)

## 🚀 Advanced Testing

### Test Multiple Models
1. Download Qwen 3.5 0.8B (1GB - fast)
2. Download Qwen 3.5 9B (6.6GB - slow)
3. Switch between them (should be instant)

### Test Concurrent Downloads
- Try downloading while another download is in progress
- Expected: Second download queues or shows already downloading

### Test Offline Mode
1. Download Qwen model
2. Disconnect internet
3. Chat with Qwen model
4. Expected: Works perfectly (100% local)

## 📝 Logging

Key log messages to watch:
```
[OllamaManager] Initialized successfully
[Ollama IPC] Handlers registered
[OllamaManager] Pulling model: qwen3.5:2b
[OllamaManager] qwen3.5:2b: 45% (downloading)
[OllamaManager] Successfully pulled qwen3.5:2b
```

## ✨ Success!

If all tests pass, users can now:
1. Click any Qwen model
2. Wait for auto-download
3. Chat with 100% local AI
4. Zero setup, zero API costs, complete privacy! 🎉
