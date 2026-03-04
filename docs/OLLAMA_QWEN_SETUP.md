# Ollama & Qwen 3.5 Setup Guide

**Added:** 2026-03-03

## Overview

Paprwork V2 now supports running AI models locally on your device using Ollama with Qwen 3.5 models. This provides:

- ✅ **Complete privacy** - All inference happens locally, no data sent to cloud
- ✅ **Zero API costs** - No per-token charges
- ✅ **Offline capable** - Works without internet connection
- ✅ **No API keys required** - Just install and run

## Installation

### Option 1: Automatic (Recommended) ✨

**No installation needed!** Just select a Qwen model in Paprwork and it will:
- Auto-install Ollama binaries
- Auto-download the selected model
- Auto-start the service

Everything happens automatically with a progress indicator.

### Option 2: Manual (For Power Users)

If you prefer to manage Ollama yourself or use it with other applications:

### Manual Installation Steps

**1. Install Ollama**

Download and install Ollama from [ollama.com](https://ollama.com):

```bash
# macOS
brew install ollama

# Or download from https://ollama.com/download
```

**2. Start Ollama Service**

```bash
ollama serve
```

This starts Ollama on `http://localhost:11434` (default port).

**3. Pull Qwen 3.5 Model**

Choose a model size based on your hardware:

```bash
# Fastest (1GB) - Good for laptops
ollama pull qwen3.5:0.8b

# Balanced (2.7GB) - Good quality/speed tradeoff
ollama pull qwen3.5:2b

# Best quality (6.6GB) - Recommended default
ollama pull qwen3.5:latest

# High quality (17GB) - Requires 32GB+ RAM
ollama pull qwen3.5:27b
```

**4. Verify Installation**

```bash
# Test the model
ollama run qwen3.5:latest "Hello, how are you?"
```

## Usage in Paprwork

**Zero Setup Required!** Paprwork automatically handles everything:

1. **Select a Qwen Model** - Open model picker → Choose "Ollama (On-Device)" group
2. **First Time Use** - Paprwork will:
   - ✅ Auto-install Ollama if not present
   - ✅ Auto-download the selected model (shows progress bar)
   - ✅ Auto-start Ollama service
3. **Chat!** - Model runs 100% locally, completely private

**Progress Indicator:** When downloading models for the first time, you'll see a purple progress bar showing download status (e.g., "Downloading qwen3.5:2b... 45%").

## Model Specifications

| Model | Size | RAM Required | Context Window | Speed |
|-------|------|--------------|----------------|-------|
| Qwen 3.5 0.8B | 1.0GB | 4GB+ | 256K tokens | Very Fast |
| Qwen 3.5 2B | 2.7GB | 8GB+ | 256K tokens | Fast |
| Qwen 3.5 4B | 3.4GB | 12GB+ | 256K tokens | Medium |
| Qwen 3.5 9B | 6.6GB | 16GB+ | 256K tokens | Medium |
| Qwen 3.5 27B | 17GB | 32GB+ | 256K tokens | Slower |

## Configuration

**Note:** If you manually install Ollama, Paprwork will detect it and use your installation instead of downloading its own binaries.

## Troubleshooting

### "Connection refused" error (Auto-install should prevent this)

**Problem:** Paprwork can't connect to Ollama (rare with auto-install).

**Solution:**
1. Restart Paprwork (it will auto-install/start Ollama)
2. Or manually start: `ollama serve`
3. Check port 11434 is available: `lsof -i :11434`

### Model not found error (Auto-install should prevent this)

**Problem:** Selected model hasn't been downloaded (rare with auto-install).

**Solution:**
1. Paprwork should auto-download on first use
2. Or manually pull: `ollama pull qwen3.5:latest`
3. Check available models: `ollama list`

### Slow performance

**Problem:** Model runs slower than expected.

**Solutions:**
1. Use a smaller model (0.8B or 2B)
2. Close other applications to free RAM
3. Ensure Ollama has enough RAM (check Activity Monitor)
4. Check CPU/GPU usage - Ollama uses all available cores

### Out of memory error

**Problem:** Model too large for available RAM.

**Solution:**
1. Use a smaller model variant
2. Close other applications
3. Upgrade system RAM

## Architecture

### Integration Points

1. **Type Definitions** (`src/core/types/agents.ts`)
   - Added `"ollama"` to `Provider` union type

2. **Model Registry** (`ui/constants/models.ts`)
   - Added Qwen 3.5 models to `CHAT_MODELS`
   - Group: "Ollama (On-Device)"
   - `requiresApiKey: "NONE"`

3. **Model Fallback** (`src/core/agents/ModelFallback.ts`)
   - Added Ollama models with 256K context window

4. **Agent Service** (`src/gateway/services/AgentService.ts`)
   - `createLanguageModel()`: Added Ollama case using `ollama-ai-provider-v2`
   - `setProviderAuth()`: Ollama skips authentication (local inference)

5. **WebSocket Handler** (`src/gateway/websocket/agent.ts`)
   - Ollama provider skips API key fetching (no auth required)

6. **UI Availability** (`ui/hooks/useAuthStatus.ts`)
   - `isModelAvailable()`: Ollama models always return `true`

### Routing Flow

```
User selects Qwen 3.5 model
    ↓
UI sends provider="ollama", model="qwen3.5:latest"
    ↓
Gateway WebSocket handler (no API key needed)
    ↓
AgentService.createLanguageModel()
    ↓
ollama-ai-provider-v2 → http://localhost:11434/api
    ↓
Ollama service → Local inference
    ↓
Stream results back to UI
```

## Benefits vs Cloud Models

| Feature | Cloud Models | Ollama (Local) |
|---------|--------------|----------------|
| Privacy | Data sent to provider | 100% local |
| Cost | Per-token charges | Free |
| Latency | Network + API | Local only |
| Offline | ❌ Requires internet | ✅ Works offline |
| Setup | API key required | Install Ollama |
| Quality | State-of-art | Good (Qwen 3.5) |

## Future Enhancements

- [ ] Auto-detect available Ollama models
- [ ] Show Ollama status indicator in UI
- [ ] Custom Ollama host configuration in settings
- [ ] Model download progress in UI
- [ ] Auto-start Ollama service on app launch
- [ ] Support for other Ollama models (Llama, Mistral, etc.)

## References

- [Ollama Documentation](https://ollama.com)
- [Qwen 3.5 Model Card](https://ollama.com/library/qwen3.5)
- [ollama-ai-provider-v2 npm package](https://www.npmjs.com/package/ollama-ai-provider-v2)
- [AI SDK Documentation](https://sdk.vercel.ai)
