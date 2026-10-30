import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TUBEDESK_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.TUBEDESK_DB || path.join(DATA_DIR, 'tubedesk.sqlite');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  title TEXT,
  handle TEXT,
  thumbnail TEXT,
  description TEXT,
  country TEXT,
  kind TEXT NOT NULL DEFAULT 'competitor', -- owned | competitor
  uploads_playlist TEXT,
  subscriber_count INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  video_count INTEGER DEFAULT 0,
  published_at TEXT,
  oauth_json TEXT,              -- refresh/access tokens for owned channels
  oauth_email TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced TEXT
);

CREATE TABLE IF NOT EXISTS competitor_links (
  owned_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  competitor_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  note TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owned_channel_id, competitor_channel_id)
);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  tags_json TEXT,
  published_at TEXT,
  duration_sec INTEGER DEFAULT 0,
  is_short INTEGER DEFAULT 0,
  is_live INTEGER DEFAULT 0,
  thumbnail TEXT,
  view_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  category_id TEXT,
  default_language TEXT,
  privacy_status TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id, published_at);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,   -- channel | video
  entity_id TEXT NOT NULL,
  taken_at TEXT NOT NULL,      -- ISO timestamp
  day TEXT NOT NULL,           -- YYYY-MM-DD
  views INTEGER DEFAULT 0,
  subs INTEGER DEFAULT 0,
  videos INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  UNIQUE(entity_type, entity_id, day)
);

CREATE TABLE IF NOT EXISTS metadata_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  field TEXT NOT NULL,         -- title | thumbnail | description | tags
  old_value TEXT,
  new_value TEXT,
  observed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mh_video ON metadata_history(video_id);

CREATE TABLE IF NOT EXISTS api_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  day TEXT NOT NULL,
  api TEXT NOT NULL,           -- data | analytics | suggest | ai
  endpoint TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  ms INTEGER DEFAULT 0,
  ok INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_api_log_day ON api_log(day);

CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS board_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,          -- video | channel | keyword | title | note | thumbnail
  ref_json TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blueprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT,
  title TEXT NOT NULL,
  idea TEXT,
  audience TEXT,
  titles_json TEXT,
  thumbnail_notes TEXT,
  proof TEXT,
  outline TEXT,
  status TEXT NOT NULL DEFAULT 'idea',  -- idea | scripted | produced | published
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comment_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  video_id TEXT,
  video_title TEXT,
  impressions INTEGER,
  ctr REAL,
  avg_view_duration_sec REAL,
  avg_view_pct REAL,
  views INTEGER,
  watch_hours REAL,
  period_label TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_studio_channel ON studio_imports(channel_id);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staged_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  field TEXT NOT NULL,         -- title | description | tags | privacy | publishAt
  old_value TEXT,
  new_value TEXT,
  status TEXT NOT NULL DEFAULT 'staged',  -- staged | applied | failed | discarded
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS keyword_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  day TEXT NOT NULL,
  suggestion_count INTEGER,
  top_video_median_views INTEGER,
  avg_channel_subs INTEGER,
  recent_upload_share REAL,
  score INTEGER,
  UNIQUE(keyword, country, day)
);

CREATE TABLE IF NOT EXISTS ai_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  feature TEXT NOT NULL,
  provider TEXT,
  prompt_chars INTEGER,
  output_chars INTEGER,
  ms INTEGER,
  ok INTEGER DEFAULT 1,
  error TEXT
);

CREATE TABLE IF NOT EXISTS saved_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT,
  kind TEXT NOT NULL,          -- idea | script | plan | audit | thumbnail_prompt
  title TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value !== '' ? row.value : fallback; // empty string = unset
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value ?? ''));
}
export function allSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export { DATA_DIR, DB_PATH };
