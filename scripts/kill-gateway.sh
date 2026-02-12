#!/bin/bash
# Kill all Paprwork Gateway processes
# Usage: npm run kill:gateway

echo "Checking for processes on port 18789..."
PID=$(lsof -ti:18789)

if [ -n "$PID" ]; then
  echo "Killing process $PID on port 18789..."
  kill $PID
  echo "✓ Port 18789 is now free"
else
  echo "✓ Port 18789 is already free"
fi

echo "Checking for any remaining paprwork processes..."
pkill -f "tsx watch src/gateway" || echo "No tsx gateway processes found"
pkill -f "node.*gateway/index" || echo "No node gateway processes found"

echo "✓ All gateway processes stopped"
