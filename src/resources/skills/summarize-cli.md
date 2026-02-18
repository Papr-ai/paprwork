---
id: preloaded-summarize-cli
name: Summarize CLI
description: Summarize files, URLs, and command output directly from the terminal using AI-powered summarization.
---
# Summarize CLI

Summarize files, web pages, and command output directly from the terminal.

## Use Cases

### Summarize a File
```bash
# Read and summarize
cat ~/Documents/long-report.md | head -500
# Then ask the agent to summarize the content
```

### Summarize a Web Page
```bash
# Fetch and extract text
curl -s "https://example.com/article" | \
  sed 's/<[^>]*>//g' | \
  head -200
# Then ask for summary
```

### Summarize Command Output
```bash
# Git log summary
git log --oneline -50

# System info
top -l 1 | head -20

# Error logs
tail -100 /var/log/system.log
```

### Summarize Multiple Files
```bash
# List and preview files
find ~/Documents -name "*.md" -mtime -7 | while read f; do
  echo "=== $f ==="
  head -20 "$f"
  echo ""
done
```

## Integration with Papr

### In Chat
User shares a long output or file, agent summarizes using appropriate format (executive, bullets, detailed).

### As a Job
Create a scheduled job that summarizes daily logs or activity:

```python
# Daily log summarizer
import subprocess
import sqlite3

# Collect logs
logs = subprocess.run(
    ["tail", "-500", "/var/log/app.log"],
    capture_output=True, text=True
).stdout

# Agent job can analyze and summarize
# Store summary in SQLite for dashboard
```

### With Documents
Read a Papr document and create a summary version:
```javascript
// Read the full document
read_document({ documentId: "long-report" })

// Create summary as new document
create_document({
  title: "Long Report - Summary",
  content: "## Executive Summary\n..."
})
```

## Summary Formats

- **One-liner**: Single sentence capture of the main point
- **Bullet points**: 5-10 key takeaways
- **Executive summary**: 2-3 paragraph overview
- **Structured**: Headings with categorized findings

## Best Practices

- For very long content, process in chunks
- Preserve key data points (numbers, names, dates)
- Indicate what was summarized and the source
- Note if content was truncated
