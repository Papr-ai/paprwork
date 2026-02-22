#!/bin/bash

# OAuth Testing Quick Start
# Run this script to prepare for testing OAuth implementation

set -e

echo "🔐 OAuth Testing Quick Start"
echo "=============================="
echo ""

# Check Node version
echo "1. Checking Node version..."
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 24 ]; then
    echo "❌ Node v24+ required (found: v$NODE_VERSION)"
    echo "   Run: nvm use 24"
    exit 1
fi
echo "✅ Node v$NODE_VERSION (OK)"
echo ""

# Build project
echo "2. Building project..."
npm run build
echo "✅ Build complete"
echo ""

# Check OAuth storage
echo "3. Checking OAuth storage..."
OAUTH_FILE="$HOME/Library/Application Support/Paprwork V2/data/oauth-tokens.json"
if [ -f "$OAUTH_FILE" ]; then
    echo "⚠️  Existing OAuth tokens found"
    read -p "   Clear existing tokens for fresh test? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        mv "$OAUTH_FILE" "$OAUTH_FILE.backup"
        echo "   ✅ Backed up to oauth-tokens.json.backup"
    fi
else
    echo "✅ No existing OAuth tokens (fresh start)"
fi
echo ""

# Check API keys
echo "4. Checking API keys..."
KEYS_FILE="$HOME/Library/Application Support/Paprwork V2/data/custom-keys.json"
if [ -f "$KEYS_FILE" ]; then
    if grep -q "OPENAI_API_KEY\|ANTHROPIC_API_KEY" "$KEYS_FILE"; then
        echo "⚠️  Existing OPENAI_API_KEY or ANTHROPIC_API_KEY found"
        echo "   These will be overwritten by OAuth tokens"
    else
        echo "✅ No conflicting API keys"
    fi
else
    echo "✅ No existing API keys"
fi
echo ""

# Check OpenAI OAuth config
echo "5. Checking OpenAI OAuth configuration..."
if grep -q 'clientId: ""' src/core/services/OpenAIOAuthService.ts; then
    echo "⚠️  OpenAI Client ID not configured"
    echo "   OpenAI OAuth will NOT work until configured"
    echo "   See: docs/OAUTH_TESTING_GUIDE.md (Configuration section)"
    echo ""
    echo "   For now, test with Claude OAuth (already configured)"
else
    echo "✅ OpenAI Client ID configured"
fi
echo ""

# Check Claude OAuth config
echo "6. Checking Claude OAuth configuration..."
if grep -q '9d1c250a-e61b-44d9-88ed-5944d1962f5e' src/core/services/ClaudeOAuthService.ts; then
    echo "✅ Claude OAuth configured (ready to test)"
else
    echo "⚠️  Claude OAuth client ID missing"
fi
echo ""

# Ready to test
echo "=============================="
echo "✅ Ready to test!"
echo ""
echo "Next steps:"
echo "1. Run: npm start"
echo "2. Open Settings → API Keys"
echo "3. Click 'Sign in with Claude'"
echo "4. Follow testing guide: docs/OAUTH_TESTING_GUIDE.md"
echo ""
echo "Quick test checklist:"
echo "  [ ] Claude OAuth login works"
echo "  [ ] Token appears in API keys list with 🔒 OAuth badge"
echo "  [ ] Chat with Claude model works"
echo "  [ ] Job using \${ANTHROPIC_API_KEY} works"
echo "  [ ] Disconnect removes OAuth key"
echo ""
echo "Logs to watch:"
echo "  - [OAuth IPC] OAuth flow completed"
echo "  - [OAuth IPC] Created/Updated ANTHROPIC_API_KEY"
echo "  - [AgentService] Using Anthropic OAuth token"
echo ""
