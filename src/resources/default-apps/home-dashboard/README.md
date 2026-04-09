# Home Dashboard - Default App

This is the default home dashboard that ships with Paprwork. It displays when users click the home button.

## Features

- Daily command center
- Meeting battle cards  
- OKR tracker
- Priority stack rank
- Action items and briefings

## Customization

Users can create agent jobs to populate this dashboard with their own data:

1. Create an agent job that generates daily/weekly brief data
2. Job saves data to its SQLite database
3. Link the job database to this app via data-sources
4. Dashboard automatically displays the data

## Data Sources

The app reads from linked job databases (data-sources.json). Users need to:

1. Create their own "Daily Brief Generator" agent job
2. Link it to this app
3. Schedule it to run daily/weekly

## Agent Job Example

```typescript
create_job({
  name: "Daily Brief Generator",
  type: "agent",
  // provider and model are optional - will use user's default
  command: `
    Generate a daily brief with:
    - Today's meetings and agenda
    - Key OKRs and their status
    - Top 3 priorities
    - Action items for today
    
    Save results to SQLite database for dashboard display.
  `,
  schedule: { enabled: true, cron: "0 7 * * *" } // Every day 7am
})
```

## Technical Details

- **App ID:** `bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c` (fixed)
- **Display Name:** "Home"
- **Location:** `~/Papr/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c/`
- **Installed:** On first launch if not already present
- **Data:** Linked job databases via data-sources.json

## File Structure

```
home-dashboard/
├── index.html          # Main HTML
├── app.js              # App logic
├── data.js             # Data loading
├── render.js           # UI rendering
├── fold_nav.js         # Navigation
├── curl.js             # Curl animation
├── curl_draw.js        # Curl drawing
├── styles.css          # Main styles
├── fold.css            # Fold navigation styles
├── cards.css           # Card styles
├── data-sources.json   # Linked databases (empty by default)
├── metadata.json       # App metadata
├── app-id.txt          # App ID
└── README.md           # This file
```
