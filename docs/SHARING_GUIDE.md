# Sharing Mini-Apps Guide (App Bundles)

Complete guide for sharing Paprwork mini-apps, jobs, and database schemas with others using app bundles.

## What are App Bundles?

**App bundles** are Paprwork's sharing format - portable packages containing:
- Complete mini-app (HTML/CSS/JS/TS)
- All related jobs (Python, Node, agent jobs)
- Database schemas (migrations + structure)
- Configuration and metadata

Think of them as "npm packages for Paprwork apps" - everything needed to recreate the app on another machine.

## Quick Start

### 1. Export Your App

Ask the agent to export your app as an app bundle:

```
Agent: "Export my Reddit Studio app as an app bundle called 'reddit-outreach'"
```

The agent creates an app bundle at `~/PAPR/bundles/reddit-outreach/` containing:
- `manifest.json` - App + job metadata, database schemas
- `README.md` - Auto-generated installation instructions
- `.gitignore` - Excludes large data files
- `apps/{appId}/` - Mini app HTML/CSS/JS/TS files
- `jobs/{jobId}/` - Job code, migrations, SQLite databases

### 2. Share via GitHub

Push the bundle to GitHub so others can import it:

```bash
cd ~/PAPR/bundles/reddit-outreach
git init
git add .
git commit -m "Initial release v1.0.0"
gh repo create papr-reddit-outreach --public --source=.
git push -u origin main
```

Alternatively, use the GitHub web interface to create a new repo and push.

### 3. Others Import

Share the GitHub URL with others. They import with one command:

```
Agent: "Import the app bundle from github.com/username/papr-reddit-outreach"
```

The agent:
1. Clones the repository
2. Validates the manifest
3. Checks for conflicts
4. Installs the app + jobs + schemas
5. Sets up databases with migrations

Done! The app is ready to use.

---

## App Bundle Structure

Every app bundle follows this structure:

```
{bundleId}/
├── manifest.json          # Schema v1.0.0 (validated with Zod)
├── README.md              # Installation guide (auto-generated)
├── .gitignore             # Excludes large files
├── apps/
│   └── {appId}/
│       ├── index.html
│       ├── app.ts
│       ├── style.css
│       └── components/
│           └── ...
└── jobs/
    └── {jobId}/
        ├── job.json       # Job metadata
        ├── code/
        │   └── main.py    # Job script
        ├── migrations/
        │   ├── 0001_baseline.sql
        │   └── 0002_events.sql
        ├── data/
        │   └── data.db    # Excluded by .gitignore
        └── requirements.txt
```

### manifest.json

The manifest defines everything needed to recreate the app:

```json
{
  "schemaVersion": "1.0.0",
  "bundleId": "bundle-twitter-intel",
  "name": "Twitter Intelligence Suite",
  "version": "1.0.0",
  "createdAt": "2026-02-18T00:00:00.000Z",
  "minPaprworkVersion": "2.0.0",
  "description": "Analyze Twitter trends and engagement",
  
  "app": {
    "id": "app-twitter-dashboard",
    "name": "Twitter Dashboard",
    "version": "1.0.0",
    "entryFile": "index.html",
    "appPath": "apps/app-twitter-dashboard",
    "description": "Real-time Twitter analytics"
  },
  
  "jobs": [
    {
      "id": "job-scraper",
      "name": "Tweet Scraper",
      "type": "python",
      "command": "python code/scraper.py",
      "dependsOn": [],
      "outputTables": ["tweets"]
    },
    {
      "id": "job-insights",
      "name": "Insights Generator",
      "type": "agent",
      "dependsOn": [
        { "jobId": "job-scraper", "onStatus": ["completed"] }
      ],
      "outputTables": ["insights"]
    }
  ],
  
  "sqlite": [
    {
      "id": "main",
      "path": "jobs/job-scraper/data/data.db",
      "migrationsPath": "jobs/job-scraper/migrations",
      "tables": [
        {
          "name": "tweets",
          "primaryKey": "id",
          "columns": ["id", "text", "author", "created_at"],
          "indexes": [
            { "name": "idx_tweets_author", "columns": ["author"] }
          ]
        }
      ]
    }
  ],
  
  "deploymentProfiles": [
    {
      "id": "local-default",
      "name": "Local Default",
      "runtimeTarget": "local",
      "environment": {}
    }
  ],
  
  "sync": {
    "preferredRoot": "~/PAPR",
    "bundleSubpath": "bundles",
    "cloudReady": true
  }
}
```

---

## Best Practices

### Versioning

Use semantic versioning (major.minor.patch):

- **Major (1.0.0 → 2.0.0)**: Breaking changes (schema changes, removed features)
- **Minor (1.0.0 → 1.1.0)**: New features, backward compatible
- **Patch (1.0.0 → 1.0.1)**: Bug fixes, no new features

Update version on every export:

```javascript
export_bundle({
  appId: "app-dashboard",
  version: "1.1.0", // Incremented from 1.0.0
  description: "Added forecasting feature"
})
```

Document changes in a CHANGELOG.md:

```markdown
## v1.1.0 - 2026-02-18
- Added forecasting job
- New chart component in dashboard
- Migration: 0003_forecasts.sql

## v1.0.0 - 2026-02-15
- Initial release
```

### Database Schemas

**Share migrations, not data.db:**
- Migrations are text files (version control friendly)
- Reproducible across environments
- Recipients apply migrations to create schema

**Include sample data (optional):**
- Create a seed migration: `9999_seed_data.sql`
- Mark as optional in README
- Keep sample data small (<100 rows)

**Document schema:**
- Describe tables in README
- Explain relationships and indexes
- Note any required migrations

Example README section:

```markdown
## Database Schema

### tweets table
- `id` (TEXT PRIMARY KEY): Tweet ID
- `text` (TEXT): Tweet content
- `author` (TEXT): Author handle
- `created_at` (TEXT): ISO timestamp
- Index: `idx_tweets_author` for author lookups

### insights table
- `id` (INTEGER PRIMARY KEY)
- `tweet_id` (TEXT): Foreign key to tweets
- `sentiment` (TEXT): positive/neutral/negative
- `score` (REAL): Confidence score 0-1
```

### Security

**Never commit secrets:**
- API keys
- Credentials
- Access tokens
- Private keys

**Scan before export:**

```bash
cd ~/PAPR/bundles/my-bundle
grep -r "sk-.*" .  # Check for OpenAI keys
grep -r "AKIA.*" . # Check for AWS keys
grep -r "ghp_.*" . # Check for GitHub tokens
```

**Use environment variables:**

```python
# ❌ Bad: Hardcoded API key
api_key = "sk-abc123..."

# ✅ Good: Environment variable
import os
api_key = os.getenv("OPENAI_API_KEY")
```

**Document required secrets in README:**

```markdown
## Configuration

Required environment variables:
- `OPENAI_API_KEY` - OpenAI API key for insights job
- `TWITTER_BEARER_TOKEN` - Twitter API v2 bearer token

Set in job configuration:
\`\`\`javascript
update_job({
  jobId: "job-scraper",
  // ... other config
})
\`\`\`
```

### Testing

**Test import in clean environment:**

1. Export bundle
2. Test import on another machine or fresh Paprwork install
3. Verify all jobs run successfully
4. Check app displays correctly

**Test checklist:**

- [ ] Bundle exports without errors
- [ ] README is complete and accurate
- [ ] No secrets in code or config
- [ ] Migrations apply successfully
- [ ] Jobs run without errors
- [ ] App loads and displays data
- [ ] All dependencies documented

---

## Common Workflows

### Creating App Templates

Create reusable templates for common patterns:

```javascript
// 1. Build reference implementation
create_app({
  title: "CRM Template",
  description: "Customer relationship management starter"
  // ... full app implementation
})

create_job({
  name: "Contact Sync",
  type: "python",
  // ... job implementation
})

// 2. Export as template
export_app_bundle({
  appId: "app-crm-template",
  name: "CRM Template",
  version: "1.0.0",
  description: "Production-ready CRM starter with contact sync"
})

// 3. Push to GitHub
// 4. Share URL: github.com/your-org/papr-crm-template

// 5. Users fork and customize
import_app_bundle({ source: "github.com/your-org/papr-crm-template" })
update_job({ jobId: "...", command: "..." }) // Customize
```

### Versioning Existing App Bundles

Release updates to existing app bundles:

```javascript
// 1. Make changes to app/jobs
edit_app_file({ appId: "app-dashboard", filename: "app.ts", ... })
update_job({ jobId: "job-processor", ... })

// 2. Export with new version
export_app_bundle({
  appId: "app-dashboard",
  bundleId: "bundle-dashboard-v2",
  version: "2.0.0",
  description: "Major update: added real-time sync"
})

// 3. Tag in Git
cd ~/PAPR/bundles/bundle-dashboard-v2
git tag v2.0.0
git push origin v2.0.0

// 4. Users update
import_app_bundle({ source: "github.com/user/dashboard" })
// Conflicts handled gracefully, manual migration if needed
```

### Forking Community App Bundles

Customize and extend community app bundles:

```javascript
// 1. Import original
import_app_bundle({ source: "github.com/community/analytics-suite" })

// 2. Modify to your needs
edit_app_file({ appId: "...", filename: "style.css", ... })
update_job({ jobId: "...", command: "..." })

// 3. Export as new app bundle
export_app_bundle({
  appId: "...",
  bundleId: "my-analytics-fork",
  version: "1.0.0",
  description: "Customized analytics with X feature"
})

// 4. Push to your GitHub
// 5. Credit original in README
```

---

## Distribution Channels

### 1. GitHub (Recommended)

**Advantages:**
- Free hosting
- Version control built-in
- Familiar to developers
- Easy to fork and contribute
- Can use GitHub Releases for versioning

**Setup:**

```bash
cd ~/PAPR/bundles/my-bundle
git init
git add .
git commit -m "Initial release"
gh repo create my-papr-bundle --public --source=.
git push -u origin main
```

**Importing:**

```
Agent: "Import from github.com/username/my-papr-bundle"
```

### 2. Direct File Sharing

**Advantages:**
- Works offline
- No GitHub account needed
- Good for internal teams

**Methods:**
- Dropbox/Google Drive shared folder
- Email (zip the app bundle first)
- Network drive
- USB transfer

**Importing:**

```
Agent: "Import from ~/Downloads/my-app-bundle"
```

### 3. App Bundle Registry (Future)

Paprwork will eventually have a public app bundle registry similar to npm or VS Code extensions:

- Browse bundles by category
- One-click install
- Ratings and reviews
- Automatic updates

For now, use GitHub and share URLs manually.

---

## Troubleshooting

### "App bundle already exists"

Export uses the bundleId. Change it or delete the existing app bundle:

```bash
rm -rf ~/PAPR/bundles/existing-bundle-id
```

### "Failed to clone repository"

Common causes:
- Invalid GitHub URL (must be github.com/user/repo)
- Private repo (authentication not supported yet)
- Network issues

**Fix:** Download the repo manually and import from local path:

```bash
git clone https://github.com/user/repo ~/Downloads/app-bundle
```

```
Agent: "Import from ~/Downloads/app-bundle"
```

### "Conflicts detected"

App or job IDs already exist. Options:

1. **Auto-rename (default):** Import proceeds, you rename manually after
2. **Block import:** Set `renameConflicts: false` in import_bundle
3. **Manual cleanup:** Delete existing app/job first

```javascript
delete_job({ jobId: "conflicting-job-id", deleteFiles: true })
import_bundle({ source: "..." })
```

### "Migrations failed"

Migration SQL has errors. Check logs:

```javascript
read_job_logs({ jobId: "imported-job-id" })
```

Fix migration files and re-run:

```bash
cd ~/PAPR/jobs/{jobId}/migrations
# Edit .sql files
```

```javascript
run_job({ jobId: "..." })
```

### "App displays but no data"

Likely causes:
- Migrations haven't run yet
- Jobs haven't populated database
- Data sources not linked

**Debug steps:**

```javascript
// 1. Check data sources
read_app_data_sources({ appId: "..." })

// 2. Check if job ran successfully
list_jobs({ status: "completed" })

// 3. Manually trigger job
run_job({ jobId: "..." })

// 4. Verify database has data
bash({ command: "sqlite3 ~/PAPR/jobs/{jobId}/data/data.db '.tables'" })
bash({ command: "sqlite3 ~/PAPR/jobs/{jobId}/data/data.db 'SELECT COUNT(*) FROM tablename;'" })
```

---

## Support & Community

### Getting Help

- **GitHub Issues:** Report bugs on the app bundle's GitHub repo
- **Paprwork Discord:** Ask questions in #app-bundles channel
- **Documentation:** Check APP_AND_JOBS_GUIDE.md for tool reference

### Contributing

Found a useful app bundle pattern? Share it!

1. Create well-documented app bundle
2. Test thoroughly
3. Push to GitHub
4. Share in community channels
5. Consider adding to awesome-papr-bundles list

### App Bundle Guidelines

Good app bundles have:
- Clear README with screenshots
- Complete installation instructions
- Documented environment variables
- Sample data or seed migration
- Test script included
- Semantic versioning
- Active maintenance

---

## Future Enhancements

Planned features for the app bundle system:

- **App bundle marketplace:** Browse and install from central registry
- **Automatic updates:** Get notified of new versions
- **Dependency resolution:** App bundles can depend on other bundles
- **Private bundles:** Authentication for private repos
- **Bundle stats:** Downloads, ratings, reviews
- **CI/CD integration:** Auto-publish on git tag

Stay tuned!
