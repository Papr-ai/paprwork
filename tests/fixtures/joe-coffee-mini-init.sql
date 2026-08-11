-- Joe Coffee Intelligence — synthetic demo schema (mini fixture for tests)
-- ALL DATA IS SYNTHETIC.

CREATE TABLE IF NOT EXISTS shops (
  shop_id TEXT PRIMARY KEY,
  name    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  id      TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  date    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_shop_date ON daily_metrics(shop_id, date);

CREATE TABLE IF NOT EXISTS menu_items (
  item_id  TEXT PRIMARY KEY,
  shop_id  TEXT NOT NULL,
  canonical TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_shop ON menu_items(shop_id);
