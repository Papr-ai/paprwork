---
id: preloaded-bird-twitter
name: Bird / X Twitter
description: Post tweets, read threads, search X/Twitter, and reply to tweets using the bird CLI tool.
---
# Bird - X/Twitter Integration

Use `bird` to read/search X and post tweets/replies.

## Prerequisites

```bash
npm install -g @steipete/bird
```

## Authentication

Bird uses browser cookies for authentication (no API keys needed):
- Automatically reads from Safari/Chrome/Firefox
- Alternative: Set `SWEETISTICS_API_KEY` environment variable
- Check auth: `bird check`
- Verify current user: `bird whoami`

## Quick Commands

### Read & Search
```bash
bird read <url-or-id>          # Read a tweet
bird thread <url-or-id>        # Read entire thread
bird search "query" -n 5       # Search tweets
bird mentions                  # Check mentions
```

### Posting (Always confirm with user first!)
```bash
bird tweet "text content"              # Post a tweet
bird reply <id-or-url> "reply text"    # Reply to a tweet
```

## Best Practices

1. **Always ask for confirmation** before posting tweets or replies
2. **Read before replying** - use `bird read` or `bird thread` to get context
3. **Search first** - use `bird search` to find relevant conversations
4. **Check authentication** - run `bird whoami` if commands fail

## Output Formats
```bash
bird search "AI tools"           # Human-readable (default)
bird search "AI tools" --json    # JSON for parsing
bird search "AI tools" --plain   # Plain text
```

## Important Notes

- Bird uses X/Twitter's private GraphQL API (can break with updates)
- Always confirm before posting/replying
- Rate limits apply - space out requests if needed
- Cookie auth requires active browser session

## When to Use

Use when the user asks to:
- Post tweets or updates to X/Twitter
- Read tweets, threads, or conversations
- Search for topics or users on X
- Reply to tweets or engage with conversations
- Check mentions or notifications
