-- Daily Brief Database Schema
-- Creates the briefs table with sample data

CREATE TABLE IF NOT EXISTS briefs (
  date TEXT PRIMARY KEY,
  brief_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Insert sample brief for today
INSERT OR REPLACE INTO briefs (date, brief_json) VALUES (
  date('now'),
  json('{
    "hero": {
      "date": "' || strftime('%A, %B %d, %Y', 'now') || '",
      "title": "Daily Brief",
      "subtitle": "4 meetings · 1 external",
      "stats": [
        {"value": "4", "label": "meetings"},
        {"value": "1", "label": "external"},
        {"value": "2", "label": "action items"}
      ]
    },
    "sections": [
      {
        "type": "timeline",
        "title": "Today",
        "items": [
          {
            "time": "9:00",
            "title": "Team Standup",
            "tags": ["internal"]
          },
          {
            "time": "10:30",
            "title": "Product Review",
            "tags": ["internal"]
          },
          {
            "time": "2:00",
            "title": "Sarah Chen — Acme Corp",
            "tags": ["external"],
            "detail": {
              "Intel": "Product Manager at mid-size tech company evaluating solutions.",
              "Angle": "Focus on ease of use and team collaboration features.",
              "The Ask": "Schedule follow-up demo with their engineering team."
            }
          },
          {
            "time": "3:30",
            "title": "Sprint Planning",
            "tags": ["internal"]
          }
        ]
      },
      {
        "type": "priorities",
        "title": "Focus This Week",
        "items": [
          {
            "rank": 1,
            "title": "Complete Q2 planning",
            "why": "Strategic priorities due Friday. Team needs clear direction."
          },
          {
            "rank": 2,
            "title": "Follow up with 3 prospects",
            "why": "Pipeline building. Warm leads from last week."
          },
          {
            "rank": 3,
            "title": "Ship feature X",
            "why": "Committed to customers. Currently in final testing."
          }
        ]
      },
      {
        "type": "tracker",
        "title": "Weekly Goals",
        "items": [
          {
            "label": "Customer calls",
            "current": 3,
            "target": 5,
            "unit": "calls",
            "context": "On track - 2 more scheduled this week"
          },
          {
            "label": "Code reviews",
            "current": 4,
            "target": 8,
            "unit": "reviews",
            "context": "Need to pick up pace"
          },
          {
            "label": "Documentation",
            "current": 2,
            "target": 3,
            "unit": "pages",
            "context": "One more page to finish"
          }
        ]
      },
      {
        "type": "alerts",
        "title": "Don''t Forget",
        "items": [
          {
            "severity": "high",
            "message": "Q2 planning deck due Friday — finish slides",
            "action": "Block 2 hours tomorrow morning"
          },
          {
            "severity": "medium",
            "message": "Team offsite next week — book venue",
            "action": "Send calendar invite today"
          }
        ]
      },
      {
        "type": "freeform",
        "title": "My Take",
        "content": "<strong>This week is about execution and follow-through.</strong> The planning work matters, but so do the customer conversations. <em>Don''t let admin tasks crowd out the important stuff.</em> Block focus time."
      }
    ]
  }')
);
