#!/bin/bash
# Script to view the latest log file
# Usage: ./scripts/view-latest-log.sh [lines]

LOGS_DIR="$(pwd)/logs"
LINES=${1:-100}

# Colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

if [ ! -d "$LOGS_DIR" ]; then
  echo -e "${YELLOW}No logs directory found at $LOGS_DIR${NC}"
  exit 1
fi

# Find the most recent log file
LATEST_LOG=$(find "$LOGS_DIR" -name "paprwork_*.log" -type f -print0 | \
  xargs -0 ls -t | head -n 1)

if [ -z "$LATEST_LOG" ]; then
  echo -e "${YELLOW}No log files found in $LOGS_DIR${NC}"
  exit 1
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Latest log: $(basename "$LATEST_LOG")${NC}"
echo -e "${BLUE}Showing last $LINES lines${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

tail -n "$LINES" "$LATEST_LOG"

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Full log: $LATEST_LOG${NC}"
echo -e "${BLUE}========================================${NC}"
