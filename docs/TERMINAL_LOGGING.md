# Terminal Logging System

**Added:** 2026-04-19

## Overview

A comprehensive logging system that saves all terminal output to timestamped log files for review and debugging. Useful for tracking issues, monitoring performance, and reviewing what happened during a session.

## Features

1. **Automatic timestamping** - Each log file includes date and time
2. **Real-time logging** - See output in terminal AND save to file simultaneously
3. **Log rotation** - Keep only N most recent logs to save disk space
4. **Easy viewing** - Quick commands to view latest logs
5. **Git ignored** - Logs folder automatically excluded from version control

## Usage

### Start with Logging

```bash
# Start Paprwork and save all output to logs/
npm run start:log
```

This creates a log file at `logs/paprwork_YYYY-MM-DD_HH-MM-SS.log` with all terminal output.

### View Latest Log

```bash
# View last 100 lines of most recent log
npm run logs:view

# View last 200 lines
./scripts/view-latest-log.sh 200

# View all lines
./scripts/view-latest-log.sh 99999
```

### Clean Old Logs

```bash
# Keep only 10 most recent logs
npm run logs:clean

# Keep only 5 most recent logs
./scripts/clean-old-logs.sh 5
```

## Log Files

### Format
- **Filename:** `paprwork_YYYY-MM-DD_HH-MM-SS.log`
- **Location:** `logs/` directory in project root
- **Content:** Complete terminal output (stdout + stderr)

### Examples
```
logs/
├── paprwork_2026-04-19_21-30-45.log
├── paprwork_2026-04-19_22-15-22.log
└── paprwork_2026-04-20_09-00-15.log
```

## What's Logged

All terminal output is captured, including:
- ✅ Gateway initialization logs
- ✅ Service startup messages
- ✅ WebSocket connections
- ✅ Job scheduler ticks
- ✅ Custom keys operations
- ✅ Database queries
- ✅ Error messages
- ✅ Performance metrics
- ✅ React component logs
- ✅ IPC communication

## Use Cases

### Debugging
```bash
# Reproduce an issue with logging enabled
npm run start:log

# After issue occurs, review the log
npm run logs:view
```

### Performance Analysis
```bash
# Run a performance-heavy operation
npm run start:log

# Review timing metrics in the log
grep "ms" logs/paprwork_*.log | tail -50
```

### Error Investigation
```bash
# Search for errors in latest log
grep -i "error" $(ls -t logs/*.log | head -n 1)

# Search for specific component logs
grep "AgentService" $(ls -t logs/*.log | head -n 1)
```

### Sharing Logs
```bash
# Copy latest log for sharing
cp $(ls -t logs/*.log | head -n 1) ~/Desktop/paprwork-debug.log
```

## Scripts Reference

### start-with-logging.sh
- Starts Paprwork with logging enabled
- Uses `tee` to show output AND save to file
- Creates timestamped log file
- Shows log file path at start and end

### view-latest-log.sh
- Finds most recent log file
- Shows last N lines (default: 100)
- Displays full file path

### clean-old-logs.sh
- Keeps N most recent logs (default: 10)
- Deletes older logs
- Shows what's being deleted
- Safe if no logs exist

## Implementation Details

### Real-time Logging
Uses `tee` command to duplicate output:
```bash
npm start 2>&1 | tee "$LOG_FILE"
```
- `2>&1` - Redirect stderr to stdout
- `tee` - Write to file AND terminal
- Unbuffered for real-time updates

### Exit Code Preservation
```bash
EXIT_CODE=${PIPESTATUS[0]}
exit $EXIT_CODE
```
Preserves npm's exit code even after piping through `tee`.

### Timestamp Format
- ISO-like: `YYYY-MM-DD_HH-MM-SS`
- Sortable by filename
- Easy to read
- No spaces (shell-friendly)

## Git Integration

The `logs/` directory is automatically ignored via `.gitignore`:
```gitignore
# Logs
*.log
npm-debug.log*
logs/
```

## Maintenance

### Disk Space Management

**Automatic cleanup:**
```bash
# Add to cron or run periodically
npm run logs:clean
```

**Manual cleanup:**
```bash
# Delete all logs older than 7 days
find logs/ -name "*.log" -mtime +7 -delete

# Delete logs by size (keep last 100MB)
du -s logs/ # Check current size
```

### Log Rotation Strategy

**Default:** Keep 10 most recent logs
**Recommended:** 5-20 logs depending on frequency

**Calculation:**
- 1 session = ~1-5 MB average
- 10 logs = ~10-50 MB
- 20 logs = ~20-100 MB

## Troubleshooting

### Logs not created
```bash
# Check logs directory exists and is writable
ls -la logs/
mkdir -p logs
chmod 755 logs
```

### Log file empty
- Check if `tee` is installed: `which tee`
- Try running without tee: `npm start > logs/test.log 2>&1`

### Can't view logs
```bash
# Check permissions
chmod 644 logs/*.log

# Check file exists
ls -lh logs/
```

## Advanced Usage

### Filter Specific Components

```bash
# View only AgentService logs
grep "AgentService" $(ls -t logs/*.log | head -n 1)

# View only errors
grep -E "(ERROR|Error|error)" $(ls -t logs/*.log | head -n 1)

# View only performance metrics
grep "ms\|memory\|CPU" $(ls -t logs/*.log | head -n 1)
```

### Compare Sessions

```bash
# Compare startup times between sessions
for log in logs/*.log; do
  echo "=== $log ==="
  grep "Gateway is ready" "$log"
done
```

### Extract Statistics

```bash
# Count tool calls in latest session
grep "Tool.*raw result" $(ls -t logs/*.log | head -n 1) | wc -l

# Count messages saved
grep "Message saved successfully" $(ls -t logs/*.log | head -n 1) | wc -l
```

## Files Created

- `scripts/start-with-logging.sh` - Main logging script
- `scripts/view-latest-log.sh` - View logs helper
- `scripts/clean-old-logs.sh` - Cleanup helper
- `logs/` - Directory containing all log files
- `docs/TERMINAL_LOGGING.md` - This documentation

## Files Changed

- `package.json` - Added `start:log`, `logs:view`, `logs:clean` scripts
- `.gitignore` - Added `logs/` directory

## Impact

- **Before:** Terminal logs lost on close, hard to review past sessions
- **After:** All logs saved with timestamps, easy review and debugging
- **Disk usage:** ~1-5 MB per session
- **Performance:** Negligible (tee is very fast)

## Future Enhancements

1. **Automatic rotation** - Delete logs older than N days
2. **Compression** - Gzip old logs to save space
3. **Log levels** - Filter by severity (info, warning, error)
4. **Search tool** - GUI for searching across all logs
5. **Export** - Package logs for bug reports
6. **Analytics** - Extract metrics from logs automatically

## Related

- Terminal files in `.cursor/projects/.../terminals/` - Live terminal state
- This logging system - Historical terminal output
