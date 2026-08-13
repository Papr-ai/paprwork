---
id: preloaded-social-media-auth
name: Social Media Authentication
description: Rate limiting guidelines and best practices for social media automation jobs using Connected Platforms.
---
# Social Media Automation Guide

This guide covers rate limiting, best practices, and usage patterns for social media automation.

## Connecting Platforms

Use the Connected Platforms feature (Settings → Platforms) or the `connect_platform` tool:

```typescript
// Check if LinkedIn is connected
connect_platform({ platform: "linkedin", action: "status" })

// Trigger connection (opens browser for login)
connect_platform({ platform: "linkedin", action: "connect" })

// Force refresh if session is stale
connect_platform({ platform: "linkedin", action: "refresh" })
```

**Supported platforms:** `linkedin`, `instagram`, `reddit`, `facebook`, `tiktok`, `twitter`

Sessions refresh automatically in the background - no manual Chrome Manager jobs needed!

## Cookie Key Names

Use these in job commands with `${KEY_NAME}` substitution:

| Platform | Cookie Keys |
|----------|-------------|
| LinkedIn | `LINKEDIN_LI_AT`, `LINKEDIN_JSESSIONID` |
| Instagram | `INSTAGRAM_SESSIONID`, `INSTAGRAM_CSRFTOKEN` |
| Facebook | `FACEBOOK_C_USER`, `FACEBOOK_XS` |
| TikTok | `TIKTOK_SESSIONID`, `TIKTOK_SID_TT` |
| Reddit | `REDDIT_REDDIT_SESSION`, `REDDIT_TOKEN_V2` |

**For X/Twitter:** Use the `bird` CLI tool instead - it handles cookies automatically.

## CRITICAL: Rate Limiting Required

**Failure to rate limit = Account ban!**

When creating ANY job that uses social media cookies:
- Max 1-3 posts per day (not every hour!)
- Add random delays (2-30 seconds between actions)
- Vary posting times (don't post at exact same time daily)

## Recommended Schedules

| Platform | Max Frequency | Best Times | Notes |
|----------|---------------|------------|-------|
| LinkedIn | 2x daily | Business hours (9-5) | Professional content only |
| Instagram | 1x daily | 11am-1pm, 7-9pm | Avoid automated Stories |
| Facebook | 3x daily | Varied | Mix content types |
| Reddit | 4x daily | Varies by subreddit | Vary subreddits |
| TikTok | 1x daily | 7-9pm | Evening posts perform better |

## Required Safety Measures

1. **Limit posting frequency** (max 1-3x per day)
2. **Add random delays** (1-5 minutes before posting)
3. **Detect rate limits** (watch for HTTP 429, CAPTCHAs)
4. **Track posts** (avoid duplicates)
5. **Circuit breaker** (stop if errors detected)

## Detection Patterns to Avoid

These patterns trigger anti-automation detection:
- Exact timing (same second every day)
- High frequency (multiple actions per minute)
- No delays (instant responses)
- Same content repeatedly
- 24/7 activity (no sleep patterns)

## Example Job with Rate Limiting

```python
import time
import random
import requests

def post_to_linkedin(content: str, li_at: str, jsessionid: str):
    # Random delay before posting (1-5 minutes)
    delay = random.randint(60, 300)
    print(f"Waiting {delay}s before posting...")
    time.sleep(delay)
    
    # Post with cookies
    cookies = {
        "li_at": li_at,
        "JSESSIONID": jsessionid
    }
    
    # ... posting logic ...
    
    # Random delay after posting
    time.sleep(random.randint(5, 30))

# Use in job with ${KEY} substitution
# create_job({ command: "python3 post.py --li-at '${LINKEDIN_LI_AT}' --jsession '${LINKEDIN_JSESSIONID}'" })
```

## Session Expiration

Typical session durations:
- LinkedIn: ~45 days (rotates tokens more frequently)
- Instagram: ~90 days
- Facebook: ~90 days
- Reddit: ~30 days
- TikTok: ~30 days

Sessions refresh automatically via the background session keeper. If a session expires, you'll see `status: "needs_reauth"` - direct user to Settings → Platforms → Reconnect.

## Security Best Practices

- Cookies are stored in the system keychain (encrypted)
- Never log or expose cookie values
- Always get user consent before posting on their behalf
- Monitor for checkpoint/verification screens
- Handle 2FA gracefully (user must complete manually)
