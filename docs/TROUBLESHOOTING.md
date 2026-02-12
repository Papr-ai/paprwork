# Troubleshooting Guide

## Common Issues

### Port Already in Use (EADDRINUSE)

**Error:**
```
Error: listen EADDRINUSE: address already in use 127.0.0.1:18789
```

**Cause:**
- Multiple instances of the Gateway are running simultaneously
- Common when switching between `npm run dev` and `npm start`
- Dev mode (`tsx watch`) keeps Gateway running in background

**Solution:**

1. **Quick fix:** Kill the gateway process
   ```bash
   npm run kill:gateway
   ```

2. **Manual fix:** Find and kill the process
   ```bash
   lsof -ti:18789  # Find PID
   kill <PID>      # Kill the process
   ```

3. **Nuclear option:** Kill all Node processes (⚠️ use with caution)
   ```bash
   pkill -f node
   ```

**Prevention:**
- Always stop `npm run dev` before running `npm start`
- Use `Ctrl+C` to cleanly stop dev servers
- Check running processes: `ps aux | grep gateway`

---

## App Won't Start

### ES Module / CommonJS Issues

**Error:**
```
SyntaxError: Named export 'X' not found. The requested module is a CommonJS module...
```

**Cause:**
- Mixing ES modules and CommonJS in TypeScript compilation
- Missing `.js` extensions in imports
- Incorrect `tsconfig.json` module settings

**Solution:**

1. **Rebuild everything:**
   ```bash
   npm run build
   npm start
   ```

2. **Check import extensions:**
   - Always use `.js` extension in imports (even for `.ts` files)
   - Example: `import { X } from './X.js'` not `'./X'`

3. **Verify tsconfig.json:**
   ```json
   {
     "module": "ESNext",
     "moduleResolution": "bundler"
   }
   ```

---

## WebSocket Connection Issues

**Symptom:**
- App window opens but UI is blank
- Console shows "WebSocket connection failed"

**Cause:**
- Gateway not running
- Port mismatch between Gateway and Electron

**Solution:**

1. **Check Gateway is running:**
   ```bash
   lsof -ti:18789  # Should return a PID
   ```

2. **Check Gateway logs:**
   - Look for `[Gateway] Server listening on http://127.0.0.1:18789`
   - Check terminal for errors

3. **Restart everything:**
   ```bash
   npm run kill:gateway
   npm start
   ```

---

## Build Issues

### TypeScript Compilation Errors

**Symptom:**
- `npm run build` fails
- Type errors in console

**Solution:**

1. **Check types:**
   ```bash
   npm run type-check
   ```

2. **Clean and rebuild:**
   ```bash
   rm -rf dist/
   npm run build
   ```

3. **Verify node_modules:**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

---

## Runtime Errors

### API Keys Not Found

**Error:**
```
[AgentService] Failed to lazy-load API keys: No API keys available
```

**Cause:**
- API keys not configured in Settings
- Keychain access denied

**Solution:**

1. **Add API keys via Settings UI:**
   - Open Paprwork
   - Click Settings (gear icon)
   - Add your OpenAI/Anthropic API key

2. **Manual fix (development only):**
   ```bash
   # Add to .env.local
   echo "OPENAI_API_KEY=sk-..." >> .env.local
   ```

---

## Development Mode Issues

### Vite Dev Server Port Conflict

**Error:**
```
Port 5173 is already in use
```

**Solution:**
```bash
# Kill vite processes
pkill -f vite

# Or change the port in ui/vite.config.ts
server: {
  port: 5174  // Different port
}
```

---

## Getting Help

If you encounter an issue not covered here:

1. **Check logs:**
   - Gateway: Terminal output with `[Gateway]` prefix
   - Electron: Terminal output with `[Electron]` prefix
   - WebSocket: Look for `[WebSocket]` messages

2. **Enable verbose logging:**
   ```bash
   NODE_ENV=development npm start
   ```

3. **Check process status:**
   ```bash
   ps aux | grep -E "(electron|gateway|paprwork)"
   lsof -ti:18789  # Check Gateway port
   lsof -ti:5173   # Check Vite dev server
   ```

4. **Full reset:**
   ```bash
   npm run kill:gateway
   rm -rf dist/
   npm run build
   npm start
   ```

---

## Known Issues

### macOS Specific

**Finder Sidebar Entries:**
- Gateway automatically adds `~/Papr/` to Finder sidebar
- This is intentional behavior
- Remove via Finder if not wanted

**Keychain Access:**
- First time: macOS may ask for Keychain permission
- Grant access for API key storage

### Performance

**Cold Start Time:**
- First launch: 2-3 seconds (loading models, initializing services)
- Subsequent launches: <1 second
- Improvement planned in future releases

---

## Debug Commands

```bash
# Check what's running
ps aux | grep paprwork

# Check ports
lsof -ti:18789  # Gateway
lsof -ti:5173   # Vite dev server

# Kill specific processes
npm run kill:gateway

# Full rebuild
rm -rf dist/ && npm run build

# Check logs
tail -f ~/.papr/logs/gateway.log  # (if logging enabled)
```

---

**Last Updated:** 2026-02-11
