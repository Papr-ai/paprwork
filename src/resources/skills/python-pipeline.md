---
id: preloaded-python-pipeline
name: Python Pipeline Starter
description: Create robust Python data pipelines for Papr jobs with proper structure, logging, and error handling.
---
# Python Pipeline Starter

Create robust, production-quality Python data pipelines for Papr jobs.

## Job Structure

```
~/PAPR/jobs/{jobId}/
  code/
    main.py              # Entry point
    requirements.txt     # Dependencies
    utils.py             # Helper functions (optional)
  data/
    data.db              # SQLite output
  logs/                  # Execution logs
```

## Template: Basic Pipeline

```python
#!/usr/bin/env python3
"""Job: [Name] - [Description]"""
import os
import sys
import json
import sqlite3
import logging
from datetime import datetime
from pathlib import Path

# Structured logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%dT%H:%M:%S'
)
log = logging.getLogger(__name__)

# Paths
JOB_DIR = Path(__file__).parent.parent
DATA_DIR = JOB_DIR / "data"
DB_PATH = DATA_DIR / "data.db"

def setup_database():
    """Create tables if they don't exist."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.commit()
    return conn

def process():
    """Main pipeline logic."""
    conn = setup_database()
    try:
        # Your pipeline logic here
        log.info("Processing started")
        
        # Example: fetch, transform, load
        results = fetch_data()
        transformed = transform(results)
        load(conn, transformed)
        
        log.info(f"Pipeline complete: {len(transformed)} records processed")
        return 0
    except Exception as e:
        log.error(f"Pipeline failed: {e}")
        return 1
    finally:
        conn.close()

def fetch_data():
    """Fetch data from source."""
    # TODO: implement
    return []

def transform(data):
    """Transform raw data."""
    # TODO: implement
    return data

def load(conn, data):
    """Load data into SQLite."""
    for row in data:
        conn.execute(
            "INSERT INTO results (date, data) VALUES (?, ?)",
            (datetime.now().isoformat(), json.dumps(row))
        )
    conn.commit()

if __name__ == "__main__":
    sys.exit(process())
```

## Best Practices

### 1. Deterministic Entry Points
Always use `if __name__ == "__main__":` with explicit exit codes:
- Exit 0 = success
- Exit 1 = failure (triggers retry if configured)

### 2. Structured Logging
Use Python's logging module, not print statements:
```python
log.info(f"Processed {count} records")
log.warning(f"Skipped {skipped} invalid rows")
log.error(f"API call failed: {error}")
```

### 3. Explicit Error Handling
```python
try:
    response = requests.get(url, timeout=30)
    response.raise_for_status()
except requests.Timeout:
    log.error("Request timed out")
    sys.exit(1)
except requests.HTTPError as e:
    log.error(f"HTTP error: {e.response.status_code}")
    sys.exit(1)
```

### 4. Environment Variables for Secrets
```python
api_key = os.environ.get('API_KEY')
if not api_key:
    log.error("API_KEY not set")
    sys.exit(1)
```

### 5. Idempotent Operations
Use `INSERT OR REPLACE` or check for existing records to handle re-runs safely.

### 6. Requirements File
Always include a `requirements.txt`:
```
requests>=2.28.0
pandas>=2.0.0
```

## Common Patterns

### API Ingestion
Fetch from REST API, paginate, store in SQLite.

### CSV Processing
Read CSV with pandas, clean/transform, write to SQLite.

### Web Scraping
Use requests + BeautifulSoup, store structured results.

### Data Aggregation
Read from multiple sources, merge, compute metrics, store summary.
