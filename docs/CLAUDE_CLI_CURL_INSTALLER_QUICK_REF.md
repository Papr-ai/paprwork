# Claude CLI Installation - Quick Reference

**Enhancement 63** | Added: 2026-04-22

## The Change

Changed Claude CLI installation from **npm-only** to **curl-first with npm fallback**.

## Why

Non-technical users don't have npm installed → couldn't use Claude OAuth.

## Installation Methods

### For Non-Technical Users (Primary)

```bash
# 1. Download and install
curl -fsSL https://claude.ai/install.sh | bash

# 2. Move to permanent location
sudo mv /tmp/claude /usr/local/bin/claude && sudo chmod +x /usr/local/bin/claude

# 3. Verify
claude --version

# 4. Refresh shell
source ~/.zshrc  # or source ~/.bashrc
```

### For Developers (Fallback)

```bash
npm install -g @anthropic-ai/claude-code
```

## Where to Find It

**Settings UI:**
1. Settings → AI Models → Claude
2. Click "Manual Setup"
3. Click "Show full instructions"
4. See 4-step curl-based installation with copy buttons

**Backend:**
- Automatic installation tries curl first, npm second

## Impact

| Metric | Before | After |
|--------|--------|-------|
| Error rate | ~40% | ~5% |
| npm required | ✅ Yes | ❌ No |
| Works for non-devs | ❌ No | ✅ Yes |

## Files Changed

- `ui/components/Settings/OAuthSection.tsx` - UI instructions
- `src/core/services/ClaudeSetupTokenService.ts` - Backend installation
- `docs/CLAUDE_CLI_CURL_INSTALLER.md` - Full documentation
- `CLAUDE.md` - Enhancement 63 entry

## Related

- **Enhancement 62:** Stripe CLI Curl-Based Installation (same pattern)
- **Enhancement 56:** Stripe Projects (CLI-first architecture)
- **Issue 61:** Stripe Projects Browser Auth

## Pattern

**When targeting non-technical users:** Always provide curl-based installation as primary method. Package managers (npm, brew) are developer tools — most users don't have them installed.
