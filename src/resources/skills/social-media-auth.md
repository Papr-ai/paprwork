---
id: preloaded-social-media-auth
name: Social Media Authentication
description: Extract browser cookies for social media job automation on LinkedIn, Instagram, Facebook, TikTok, Reddit.
---
# Social Media Authentication & Cookie Extraction

Extract cookies from the user's Chrome or Safari browser (where they're already logged in) to enable automated posting/commenting jobs.

## CRITICAL: Rate Limiting Required

When creating ANY job that uses social media cookies, you MUST implement rate limiting:
- Max 1-3 posts per day (not every hour!)
- Add random delays (2-30 seconds between actions)
- Vary posting times (don't post at exact same time daily)
- Failure to rate limit = Account ban!

## Supported Platforms

- **LinkedIn** - Post updates, comment, message
- **Instagram** - Post photos/videos, comment, like
- **Facebook** - Post status, comment, share
- **TikTok** - Post videos, comment
- **Reddit** - Post, comment, vote

For X/Twitter, use the `bird-twitter` skill instead.

## Cookie Extraction Process

### Step 1: Extract Cookies via Puppeteer

```javascript
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({
  headless: false,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  userDataDir: os.homedir() + '/Library/Application Support/Google/Chrome/Default',
  args: ['--disable-blink-features=AutomationControlled']
});
const page = await browser.newPage();
await page.goto('https://www.linkedin.com', { waitUntil: 'networkidle2' });
const cookies = await page.cookies();
await browser.close();
```

### Step 2: Save Required Cookies

Save cookies securely using the Custom API Keys system in Settings.

### Platform-Specific Cookies

| Platform | Required Cookies |
|----------|-----------------|
| LinkedIn | `li_at`, `JSESSIONID` |
| Instagram | `sessionid`, `csrftoken` |
| Facebook | `sessionid`, `csrftoken` |
| TikTok | `sessionid`, `sid_tt` |
| Reddit | `reddit_session`, `token_v2` |

### Step 3: Create Job with Cookies

```javascript
create_job({
  name: "LinkedIn Daily Poster",
  type: "python",
  schedule: "0 9 * * *",
  // Reference saved cookies via env vars
})
```

## Rate Limiting Rules

### Recommended Schedules

| Platform | Recommended | Notes |
|----------|-------------|-------|
| LinkedIn | 2x daily max | Business hours only |
| Instagram | 1x daily | Avoid automated Stories |
| Facebook | 3x daily | Vary posting times |
| Reddit | 4x daily | Vary subreddits |
| TikTok | 1x daily | Evening posts perform better |

### Required Safety Measures

1. **Limit posting frequency** (max 1-3x per day)
2. **Add random delays** (1-5 minutes before posting)
3. **Detect rate limits** (watch for HTTP 429, CAPTCHAs)
4. **Track posts** (avoid duplicates)
5. **Circuit breaker** (stop if errors detected)

### Detection Patterns to Avoid
- Exact timing (same second every day)
- High frequency (multiple actions per minute)
- No delays (instant responses)
- Same content repeatedly
- 24/7 activity

## Why Real Browser Cookies

**Advantage over isolated browser:**
- User already logged in (no duplicate login)
- Cookies stay fresh as user continues using platform
- No stale sessions

## Security

- Always encrypt cookies (use Custom API Keys storage)
- Monitor cookie expiration (30-90 days typical)
- Implement re-authentication flow when cookies expire
- Get user consent before posting on their behalf
