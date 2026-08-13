#!/bin/bash
#
# Simple HTTP test for Connected Platforms feature
# Run this while the Paprwork app is open
#

echo "=============================================="
echo "Connected Platforms E2E Test (HTTP)"
echo "=============================================="
echo ""

# Test 1: Check Gateway health
echo "📋 Test 1: Gateway health..."
response=$(curl -s http://localhost:18789/health)
if [ -n "$response" ]; then
    echo "   ✅ Gateway is healthy: $response"
else
    echo "   ❌ Gateway not responding. Make sure Paprwork app is running."
    exit 1
fi
echo ""

# Test 2: List platforms (via REST endpoint if available)
echo "📋 Test 2: Testing platform registry..."
# We can test the agent tool directly via the bash approach
cat > /tmp/test-platform.js << 'EOF'
const http = require('http');

// WebSocket test using native Node.js
const WebSocket = require('/Users/amirkabbara/Documents/GitHub/paprwork-v2/node_modules/ws');

const ws = new WebSocket('ws://localhost:18789');

ws.on('open', function open() {
    console.log('   ✅ WebSocket connected');
    
    // Send get-all-platforms request
    const msg = JSON.stringify({
        id: 'test-1',
        type: 'platform:get-all',
        payload: {}
    });
    ws.send(msg);
    console.log('   Sent: platform:get-all');
});

ws.on('message', function message(data) {
    try {
        const response = JSON.parse(data.toString());
        if (response.id === 'test-1') {
            console.log('   ✅ Received response');
            if (response.success) {
                console.log('   Platforms:', JSON.stringify(response.data, null, 2));
            } else {
                console.log('   Error:', response.error);
            }
            ws.close();
        }
    } catch (e) {
        console.log('   Parse error:', e.message);
    }
});

ws.on('error', function error(err) {
    console.log('   ❌ WebSocket error:', err.message);
    process.exit(1);
});

// Timeout after 5 seconds
setTimeout(() => {
    console.log('   ❌ Timeout waiting for response');
    ws.close();
    process.exit(1);
}, 5000);
EOF

node /tmp/test-platform.js
echo ""

echo "=============================================="
echo "Test complete!"
echo ""
echo "To do a full manual E2E test:"
echo "1. Open Paprwork app"
echo "2. Go to Settings → Platforms"
echo "3. Click 'Connect' on LinkedIn (or other platform)"
echo "4. Log in manually in the browser that opens"
echo "5. Check that status shows 'Connected'"
echo "=============================================="
