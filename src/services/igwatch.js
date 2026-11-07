// Instagram Reels for the virality radar: pulls your recent media and their insights (views, reach, likes,
// comments, shares, saves) through the Instagram Graph API you already connected for publishing, and keeps a
// local copy so earlier reels form the baseline for new ones. `views` is Instagram's current Reels metric
// (plays was retired in April 2025).
import { db, getSetting } from '../db.js';
import { ig, instagramStatus } from './publish.js';

db.exec(`
CREATE TABLE IF NOT EXISTS ig_media (
  id TEXT PRIMARY KEY,
  ig_user_id TEXT,
  caption TEXT,
  media_type TEXT,
  product_type TEXT,
  published_at TEXT,
  permalink TEXT,
  thumbnail TEXT,
  views INTEGER, reach INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saved INTEGER,
  insights_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export const configured = () => instagramStatus().configured;
export const igChannelId = () => 'ig:' + (getSetting('ig_user_id') || 'unknown');
// Instagram returns "+0000"; normalise to an ISO offset every runtime parses.
const iso = t => t ? new Date(String(t).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).toISOString() : null;

async function insights(id) {
  const r = await ig(`${id}/insights`, { params: { metric: 'views,reach,saved,shares,total_interactions' } });
  const out = {};
  for (const m of r.data || []) out[m.name] = Number(m.values?.[0]?.value ?? m.total_value?.value ?? 0);
  return out;
}

/**
 * Refresh the latest `limit` media; insights are fetched for Reels younger than `insightsDays` (all when null).
 * Returns the reels that were refreshed.
 */
export async function syncMedia({ limit = 25, insightsDays = null } = {}) {
  if (!configured()) return [];
  const user = getSetting('ig_user_id');
  const list = await ig(`${user}/media`, { params: { fields: 'id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count', limit } });
  const up = db.prepare(`INSERT INTO ig_media (id, ig_user_id, caption, media_type, product_type, published_at, permalink, thumbnail, likes, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET caption = excluded.caption, thumbnail = excluded.thumbnail, likes = excluded.likes, comments = excluded.comments, permalink = excluded.permalink, updated_at = datetime('now')`);
  const reels = [];
  for (const m of list.data || []) {
    const isReel = m.media_product_type === 'REELS' || (m.media_type === 'VIDEO' && m.media_product_type !== 'STORY');
    up.run(m.id, user, m.caption || '', m.media_type, m.media_product_type || null, iso(m.timestamp), m.permalink || null, m.thumbnail_url || m.media_url || null, m.like_count ?? null, m.comments_count ?? null);
    if (!isReel) continue;
    const ageDays = (Date.now() - Date.parse(iso(m.timestamp))) / 86400000;
    if (insightsDays !== null && ageDays > insightsDays) continue;
    try {
      const i = await insights(m.id);
      db.prepare("UPDATE ig_media SET views = ?, reach = ?, saved = ?, shares = ?, insights_at = datetime('now') WHERE id = ?").run(i.views ?? null, i.reach ?? null, i.saved ?? null, i.shares ?? null, m.id);
    } catch { /* insights need instagram_business_manage_insights; listing still works without */ }
    reels.push(get(m.id));
  }
  return reels;
}

export function get(id) { return db.prepare('SELECT * FROM ig_media WHERE id = ?').get(id); }
/** Earlier reels as baseline peers: [{ageH, views}]. */
export function peers(excludeId = null) {
  return db.prepare("SELECT published_at, views FROM ig_media WHERE id != ? AND views IS NOT NULL AND (product_type = 'REELS' OR media_type = 'VIDEO')").all(String(excludeId || '').replace(/^ig:/, ''))
    .map(r => ({ ageH: (Date.now() - Date.parse(r.published_at)) / 3600000, views: r.views }));
}
