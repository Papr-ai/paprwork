#!/bin/bash
# Script to clean old log files
# Keeps only the most recent N logs (default: 10)

LOGS_DIR="$(pwd)/logs"
KEEP_COUNT=${1:-10}

# Colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

if [ ! -d "$LOGS_DIR" ]; then
  echo -e "${YELLOW}No logs directory found at $LOGS_DIR${NC}"
  exit 0
fi

# Count total log files
TOTAL_LOGS=$(find "$LOGS_DIR" -name "paprwork_*.log" | wc -l | tr -d ' ')

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Cleaning old log files${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "Total logs: $TOTAL_LOGS"
echo -e "Keeping: $KEEP_COUNT most recent"
echo ""

if [ "$TOTAL_LOGS" -le "$KEEP_COUNT" ]; then
  echo -e "${GREEN}No cleanup needed - have $TOTAL_LOGS logs, keeping $KEEP_COUNT${NC}"
  exit 0
fi

# Calculate how many to delete
TO_DELETE=$((TOTAL_LOGS - KEEP_COUNT))

echo -e "${YELLOW}Deleting $TO_DELETE old log file(s)...${NC}"
echo ""

# Find and delete oldest log files
find "$LOGS_DIR" -name "paprwork_*.log" -type f -print0 | \
  xargs -0 ls -t | \
  tail -n "$TO_DELETE" | \
  while read file; do
    echo "  Deleting: $(basename "$file")"
    rm "$file"
  done

echo ""
echo -e "${GREEN}✓ Cleanup complete${NC}"
echo -e "${BLUE}========================================${NC}"
