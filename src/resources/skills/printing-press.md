---
id: preloaded-printing-press
name: Printing Press CLIs
description: Access 160+ token-efficient CLIs with local SQLite mirrors for complex queries APIs can't handle. Linear, Notion, Slack, flights, weather, and more.
---
# Printing Press CLI Ecosystem

## What is Printing Press?

Printing Press provides **160+ agent-native CLIs** designed specifically for AI agents:

- **Local SQLite mirrors** (Linear, Notion, Slack) enable complex SQL queries APIs can't answer
- **Token-efficient output** optimized for AI consumption
- **Compound commands** combine multiple APIs in one call
- **Zero API key** for many services (scrapes responsibly)
- **50ms queries** instead of multiple round-trip API calls

## Discovery: Browse All Available CLIs

```bash
# Fetch the live catalog
curl -s https://raw.githubusercontent.com/mvanhorn/printing-press-library/main/registry.json
```

The registry contains:
- `name` - CLI identifier (used as `pp-[name]`)
- `category` - One of: developer-tools, productivity, commerce, marketing, travel, food-and-dining, etc.
- `api` - Service name (Linear, Slack, Notion, etc.)
- `description` - What it does
- `mcp` - MCP server info (if available)
- `path` - GitHub path for full docs

## Installation

```bash
# Install any CLI from the catalog
npx -y @mvanhorn/printing-press install [cli-name]

# Example: Install Linear CLI
npx -y @mvanhorn/printing-press install linear

# Then use it
pp-linear --help
```

## Popular CLIs by Category

### Developer Tools
- **pp-docker-hub** - Search container images, tags, sizes
- **pp-company-goat** - Research startups (SEC filings, GitHub activity, HN mentions)
- **pp-pypi** - PyPI package metadata, versions, vulnerabilities
- **pp-nvd** - CVE security vulnerabilities database
- **pp-trigger-dev** - Durable background jobs orchestration

### Productivity & Work
- **pp-notion** - Notion with offline SQL joins, cross-workspace queries
- **pp-linear** - Linear with local SQLite for complex issue queries
- **pp-slack** - Send messages, search conversations, monitor channels
- **pp-cal-com** - Scheduling, booking flows, agenda views
- **pp-fireflies** - Meeting transcripts, cross-meeting intelligence

### Commerce & Shopping
- **pp-shopify** - Store management, inventory, analytics
- **pp-instacart** - Natural language grocery ordering
- **pp-fedex** - Shipping, tracking, rate quotes
- **pp-amazon-seller** - FBA inventory, orders, sales reports
- **pp-ebay** - Bid sniping, watchlist intelligence, sold comps

### Travel
- **pp-flight-goat** - Google Flights + FlightAware + Kayak in one CLI
- **pp-airbnb** - Search Airbnb/VRBO, find direct booking sites
- **pp-seats-aero** - Award travel availability, cached search

### Marketing & Analytics
- **pp-ahrefs** - Backlinks, keywords, rank tracking, SERP data
- **pp-google-ads** - Campaigns, budgets, conversions, GAQL reporting
- **pp-klaviyo** - Email marketing automation, segments, flows

### Food & Dining
- **pp-allrecipes** - Recipe search, ingredient scaling, grocery lists
- **pp-dominos** - Order pizza, optimize deals, track delivery

### Media & Info
- **pp-hackernews** - HN with local SQLite, snapshot history
- **pp-wikipedia** - Article summaries, search, related topics
- **pp-steam-web** - Steam players, games, achievements, stats

### Other Useful
- **pp-open-meteo** - Weather forecasts, historical data, air quality
- **pp-weather-goat** - Weather + activity verdicts (walk, bike, hike)
- **pp-craigslist** - Search with SQLite history, scam scoring

## When to Use PP CLI vs. Direct API

### Use Printing Press CLI when:
1. **Complex SQL needed** - "Find blocked issues whose blocker hasn't moved in 7 days"
2. **Combining APIs** - "When does OKC play next + cheapest fly-in flight"
3. **Local caching** - Faster queries, offline access
4. **API limitations** - Service doesn't support the query you need
5. **No API key** - PP can scrape public data responsibly

### Use Direct API when:
1. **Simple lookup** - Single record fetch
2. **Real-time required** - Stock prices, live sports scores
3. **PP CLI doesn't exist** - Service not in catalog
4. **Write operations** - Creating/updating records (PP is often read-only)

## Practical Examples

### Example 1: Track Stale Linear Work (Daily Job)

```javascript
// First install the CLI
bash.execute("npx -y @mvanhorn/printing-press install linear");

// Then create a daily monitoring job
create_job({
  name: "Daily Linear Stale Issues",
  type: "bash",
  schedule: "0 9 * * 1-5", // Weekdays at 9am
  code: `
    pp-linear sql "
      SELECT i.identifier, i.title, 
             CAST((julianday('now') - julianday(b.updated_at)) AS INTEGER) AS stuck_days
      FROM issues i 
      JOIN issue_relations r ON r.issue_id = i.id
      JOIN issues b ON b.id = r.related_issue_id
      WHERE r.type = 'blocked_by' 
        AND b.state = 'in_progress'
        AND b.updated_at < datetime('now', '-7 days')
      ORDER BY stuck_days DESC
    "
  `,
  deliverTo: "chat"
});
```

### Example 2: Compound Flight + Sports Query

```bash
# When does OKC play next, and what's the cheapest fly-in?
pp-espn nba okc next-game && pp-flight-goat sea-okc same-day
```

### Example 3: Portfolio Tracker Mini-App

```javascript
// Install Yahoo Finance CLI
bash.execute("npx -y @mvanhorn/printing-press install yahoo-finance");

// Create mini-app that tracks portfolio
create_app({
  name: "Portfolio Tracker",
  type: "scheduled",
  schedule: "0 16 * * 1-5", // Weekdays at 4pm (market close)
  code: `
    import { db } from 'papr:db';
    import { execSync } from 'child_process';
    
    const portfolio = { AAPL: 50, MSFT: 30, GOOGL: 20 };
    
    for (const [symbol, shares] of Object.entries(portfolio)) {
      const output = execSync(\`pp-yahoo-finance quote \${symbol}\`).toString();
      const data = JSON.parse(output);
      
      db.execute(
        'INSERT INTO portfolio_history (date, symbol, price, value) VALUES (?, ?, ?, ?)',
        [new Date().toISOString(), symbol, data.price, data.price * shares]
      );
    }
  `
});
```

### Example 4: Discover CLIs Programmatically

```javascript
// Agent can search registry for relevant CLIs
const result = bash.execute(`
  curl -s https://raw.githubusercontent.com/mvanhorn/printing-press-library/main/registry.json | \\
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for entry in data['entries']:
    if 'linear' in entry['name'].lower() or 'linear' in entry['description'].lower():
        print(f\\"{entry['name']}: {entry['description']}\\")
"
`);
```

## Integration with Paprwork Features

### Jobs
- Create bash jobs that run PP CLIs on schedule
- Deliver results to chat or store in SQLite
- Chain multiple CLIs together

### Mini-Apps
- Use PP CLIs as data sources
- Store historical data in mini-app database
- Build dashboards from PP CLI output

### Sub-Agents
- Assign specific PP CLIs to specialist agents
- Research agent gets pp-hackernews, pp-wikipedia
- DevOps agent gets pp-docker-hub, pp-sentry

## Limitations

- Most CLIs are **read-only** (by design for safety)
- Some require **cookies/auth** (stored in env vars)
- **Rate limits** apply (CLIs handle this gracefully)
- **Not for real-time trading** (15-20 min delays common)

## Getting Full Documentation

Each CLI has full docs in the GitHub repo:

```bash
# Pattern: https://github.com/mvanhorn/printing-press-library/tree/main/[path]

# Example for Linear:
# https://github.com/mvanhorn/printing-press-library/tree/main/library/productivity/linear
```

## Quick Reference Commands

```bash
# Browse catalog
curl -s https://raw.githubusercontent.com/mvanhorn/printing-press-library/main/registry.json | python3 -m json.tool

# Install CLI
npx -y @mvanhorn/printing-press install [cli-name]

# Check installed PP CLIs
ls -la ~/.local/bin/pp-* 2>/dev/null || ls -la /usr/local/bin/pp-* 2>/dev/null

# Get help
pp-[name] --help
```

## Pro Tips

1. **Check before installing** - Query registry first to confirm CLI exists
2. **Use jobs for scheduling** - PP CLIs work great in scheduled bash jobs
3. **Store in SQLite** - Persist CLI output for historical analysis
4. **Combine with Paprwork tools** - Use bash.execute() to call PP CLIs
5. **MCP servers available** - Many CLIs include MCP servers for richer integration
