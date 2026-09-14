CREATE TABLE IF NOT EXISTS audits (
    id TEXT PRIMARY KEY,
    company_name TEXT,
    site_name TEXT,
    website_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    headline TEXT,
    executive_brief TEXT,
    biggest_gap TEXT,
    error TEXT,
    owner_session TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    url TEXT NOT NULL,
    status_code INTEGER,
    title TEXT,
    title_length INTEGER,
    meta_description TEXT,
    meta_desc_length INTEGER,
    h1_count INTEGER DEFAULT 0,
    h2_count INTEGER DEFAULT 0,
    img_count INTEGER DEFAULT 0,
    img_missing_alt INTEGER DEFAULT 0,
    internal_links INTEGER DEFAULT 0,
    external_links INTEGER DEFAULT 0,
    word_count INTEGER DEFAULT 0,
    load_time_ms INTEGER,
    score REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id TEXT NOT NULL,
    label TEXT NOT NULL,
    value TEXT NOT NULL,
    subtitle TEXT,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id TEXT NOT NULL,
    dimension TEXT NOT NULL,
    module_key TEXT NOT NULL,
    score INTEGER NOT NULL,
    rationale TEXT,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_modules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id TEXT NOT NULL,
    module_key TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    sort_order INTEGER DEFAULT 0,
    signal TEXT,
    implication TEXT,
    next_move TEXT,
    content_md TEXT,
    gated INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    impact TEXT,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_next_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT NOT NULL,
    effort TEXT NOT NULL,
    category TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);
