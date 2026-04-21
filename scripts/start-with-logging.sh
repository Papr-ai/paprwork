#!/bin/bash
# Script to start Paprwork with terminal logging
# Saves all output to logs/ folder with timestamps

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Create logs directory if it doesn't exist
LOGS_DIR="$(pwd)/logs"
mkdir -p "$LOGS_DIR"

# Generate timestamp for log file
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
LOG_FILE="$LOGS_DIR/paprwork_$TIMESTAMP.log"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Starting Paprwork with logging enabled${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Log file: $LOG_FILE${NC}"
echo ""

# Start npm with logging (both stdout and stderr)
# Using unbuffered output for real-time logging
npm start 2>&1 | tee "$LOG_FILE"

# Save exit code
EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Session ended at $(date)${NC}"
echo -e "${GREEN}Log saved to: $LOG_FILE${NC}"
echo -e "${BLUE}========================================${NC}"

exit $EXIT_CODE
