import { db, today } from '../db.js';
import { ytGet, parseDuration, isShort, bestThumb, chunk, DEFAULT_TTL, YouTubeError } from '../youtube/client.js';
import { isAuthorized, clearTokens } from '../youtube/oauth.js';

/** Accepts a channel ID, @handle, channel/video URL, or plain name and resolves to a channel resource. */
export async function resolveChannel(input) {
  const s = String(input || '').trim();
  if (!s) throw new YouTubeError('Empty channel reference', { status: 400 });
  let id = null, handle = null, videoId = null, legacyUser = null, custom = null;
  if (/^UC[\w-]{22}$/.test(s)) id = s;
  else if (/^@[\w.-]+$/.test(s)) handle = s;
  else if (/youtu\.?be/.test(s)) {
    let u; try { u = new URL(s.startsWith('http') ? s : 'https://' + s); } catch {}
    if (u) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'channel' && parts[1]) id = parts[1];
      else if (parts[0]?.startsWith('@')) handle = parts[0];
      else if (parts[0] === 'user' && parts[1]) legacyUser = parts[1];
      else if (parts[0] === 'c' && parts[1]) custom = parts[1];
      else if (parts[0] === 'watch') videoId = u.searchParams.get('v');
      else if (parts[0] === 'shorts' && parts[1]) videoId = parts[1];
      else if (u.hostname === 'youtu.be' && parts[0]) videoId = parts[0];
    }
  } else if (/^[\w-]{11}$/.test(s)) videoId = s;
  else handle = s.startsWith('@') ? s : '@' + s.replace(/\s+/g, '');

  const part = 'snippet,statistics,contentDetails,brandingSettings';
  let res;
  if (id) res = await ytGet('channels.list', { part, id }, { ttl: DEFAULT_TTL.channel });
  else if (handle) res = await ytGet('channels.list', { part, forHandle: handle }, { ttl: DEFAULT_TTL.channel });
  else if (legacyUser) res = await ytGet('channels.list', { part, forUsername: legacyUser }, { ttl: DEFAULT_TTL.channel });
  else if (videoId) {
    const v = await ytGet('videos.list', { part: 'snippet', id: videoId }, { ttl: DEFAULT_TTL.videoStats });
    const cid = v.items?.[0]?.snippet?.channelId;
    if (!cid) throw new YouTubeError('Video not found', { status: 404 });
    res = await ytGet('channels.list', { part, id: cid }, { ttl: DEFAULT_TTL.channel });
  }
  if ((!res || !res.items?.length) && (custom || handle)) {
    // Last resort: a 100-unit search by name.
    const q = custom || handle.replace(/^@/, '');
    const sr = await ytGet('search.list', { part: 'snippet', q, type: 'channel', maxResults: 1 }, { ttl: DEFAULT_TTL.search });
    const cid = sr.items?.[0]?.snippet?.channelId;
    if (cid) res = await ytGet('channels.list', { part, id: cid }, { ttl: DEFAULT_TTL.channel });
  }
  const item = res?.items?.[0];
  if (!item) throw new YouTubeError(`Channel not found for "${s}"`, { status: 404 });
  return item;
}

export function channelFromResource(item) {
  return {
    id: item.id,
    title: item.snippet?.title,
    handle: item.snippet?.customUrl || null,
    thumbnail: bestThumb(item.snippet?.thumbnails),
    description: item.snippet?.description || '',
    country: item.snippet?.country || item.brandingSettings?.channel?.country || null,
    uploads_playlist: item.contentDetails?.relatedPlaylists?.uploads || null,
    subscriber_count: Number(item.statistics?.subscriberCount || 0),
    view_count: Number(item.statistics?.viewCount || 0),
    video_count: Number(item.statistics?.videoCount || 0),
    published_at: item.snippet?.publishedAt || null,
  };
}

export function upsertChannel(c, kind) {
  const existing = db.prepare('SELECT kind FROM channels WHERE id = ?').get(c.id);
  const finalKind = existing?.kind === 'owned' ? 'owned' : (kind || existing?.kind || 'competitor');
  db.prepare(`INSERT INTO channels (id, title, handle, thumbnail, description, country, kind, uploads_playlist, subscriber_count, view_count, video_count, published_at, last_synced)
    VALUES (@id, @title, @handle, @thumbnail, @description, @country, @kind, @uploads_playlist, @subscriber_count, @view_count, @video_count, @published_at, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, handle=excluded.handle, thumbnail=excluded.thumbnail, description=excluded.description,
      country=excluded.country, kind=excluded.kind, uploads_playlist=excluded.uploads_playlist, subscriber_count=excluded.subscriber_count,
      view_count=excluded.view_count, video_count=excluded.video_count, published_at=excluded.published_at, last_synced=datetime('now')`)
    .run({ ...c, kind: finalKind });
  snapshotChannel(c);
  return getChannel(c.id);
}

export function snapshotChannel(c) {
  db.prepare(`INSERT INTO snapshots (entity_type, entity_id, taken_at, day, views, subs, videos)
    VALUES ('channel', ?, datetime('now'), ?, ?, ?, ?)
    ON CONFLICT(entity_type, entity_id, day) DO UPDATE SET views=excluded.views, subs=excluded.subs, videos=excluded.videos, taken_at=excluded.taken_at`)
    .run(c.id, today(), c.view_count, c.subscriber_count, c.video_count);
}

export function getChannel(id) {
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!row) return null;
  return publicChannel(row);
}
export function publicChannel(row) {
  const { oauth_json, ...rest } = row;
  return { ...rest, authorized: !!(oauth_json && JSON.parse(oauth_json).refresh_token) };
}
export function listChannels(kind = null) {
  const rows = kind ? db.prepare('SELECT * FROM channels WHERE kind = ? ORDER BY added_at').all(kind)
    : db.prepare('SELECT * FROM channels ORDER BY kind DESC, added_at').all();
  return rows.map(publicChannel);
}

export async function addChannel(input, kind = 'competitor') {
  const item = await resolveChannel(input);
  const c = channelFromResource(item);
  return upsertChannel(c, kind);
}

export function removeChannel(id) {
  return db.prepare('DELETE FROM channels WHERE id = ?').run(id).changes;
}
export function setKind(id, kind) {
  if (kind !== 'owned') clearTokens(id);
  db.prepare('UPDATE channels SET kind = ? WHERE id = ?').run(kind, id);
  return getChannel(id);
}

export async function refreshChannel(id, { force = false } = {}) {
  const res = await ytGet('channels.list', { part: 'snippet,statistics,contentDetails,brandingSettings', id }, { ttl: DEFAULT_TTL.channel, noCache: force });
  const item = res.items?.[0];
  if (!item) throw new YouTubeError('Channel no longer available', { status: 404 });
  return upsertChannel(channelFromResource(item));
}

/**
 * Sync a channel's uploads into the videos table and snapshot each video's counts.
 * maxVideos caps quota: each 50 videos costs 2 units (1 playlistItems + 1 videos.list).
 */
export async function syncVideos(channelId, { maxVideos = 500, force = false } = {}) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch) throw new YouTubeError('Unknown channel', { status: 404 });
  if (!ch.uploads_playlist) await refreshChannel(channelId, { force: true });
  const playlist = db.prepare('SELECT uploads_playlist FROM channels WHERE id = ?').get(channelId).uploads_playlist;
  const ids = [];
  let pageToken;
  while (ids.length < maxVideos) {
    const page = await ytGet('playlistItems.list', { part: 'contentDetails', playlistId: playlist, maxResults: 50, pageToken }, { ttl: DEFAULT_TTL.uploads, noCache: force });
    for (const it of page.items || []) ids.push(it.contentDetails.videoId);
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  const upsert = db.prepare(`INSERT INTO videos (id, channel_id, title, description, tags_json, published_at, duration_sec, is_short, is_live, thumbnail, view_count, like_count, comment_count, category_id, default_language, privacy_status, fetched_at)
    VALUES (@id, @channel_id, @title, @description, @tags_json, @published_at, @duration_sec, @is_short, @is_live, @thumbnail, @view_count, @like_count, @comment_count, @category_id, @default_language, @privacy_status, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, tags_json=excluded.tags_json, published_at=excluded.published_at,
      duration_sec=excluded.duration_sec, is_short=excluded.is_short, is_live=excluded.is_live, thumbnail=excluded.thumbnail, view_count=excluded.view_count,
      like_count=excluded.like_count, comment_count=excluded.comment_count, category_id=excluded.category_id, default_language=excluded.default_language,
      privacy_status=excluded.privacy_status, fetched_at=datetime('now')`);
  const snap = db.prepare(`INSERT INTO snapshots (entity_type, entity_id, taken_at, day, views, likes, comments)
    VALUES ('video', ?, datetime('now'), ?, ?, ?, ?)
    ON CONFLICT(entity_type, entity_id, day) DO UPDATE SET views=excluded.views, likes=excluded.likes, comments=excluded.comments, taken_at=excluded.taken_at`);
  const hist = db.prepare('INSERT INTO metadata_history (video_id, field, old_value, new_value) VALUES (?, ?, ?, ?)');
  const prevStmt = db.prepare('SELECT title, thumbnail, description, tags_json FROM videos WHERE id = ?');
  let count = 0, changes = 0;
  for (const group of chunk(ids, 50)) {
    const res = await ytGet('videos.list', { part: 'snippet,statistics,contentDetails,status', id: group.join(','), maxResults: 50 }, { ttl: DEFAULT_TTL.videoStats, noCache: force });
    const tx = db.transaction(items => {
      for (const v of items) {
        const dur = parseDuration(v.contentDetails?.duration);
        const row = {
          id: v.id, channel_id: channelId, title: v.snippet?.title || '', description: v.snippet?.description || '',
          tags_json: JSON.stringify(v.snippet?.tags || []), published_at: v.snippet?.publishedAt,
          duration_sec: dur, is_short: isShort(dur, v.snippet?.title, v.snippet?.description) ? 1 : 0,
          is_live: v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none' ? 1 : 0,
          thumbnail: bestThumb(v.snippet?.thumbnails), view_count: Number(v.statistics?.viewCount || 0),
          like_count: Number(v.statistics?.likeCount || 0), comment_count: Number(v.statistics?.commentCount || 0),
          category_id: v.snippet?.categoryId || null, default_language: v.snippet?.defaultLanguage || v.snippet?.defaultAudioLanguage || null,
          privacy_status: v.status?.privacyStatus || null,
        };
        const prev = prevStmt.get(v.id);
        if (prev) {
          if (prev.title !== row.title) { hist.run(v.id, 'title', prev.title, row.title); changes++; }
          const prevThumbBase = (prev.thumbnail || '').split('?')[0], nextThumbBase = (row.thumbnail || '').split('?')[0];
          if (prev.thumbnail && prevThumbBase !== nextThumbBase) { hist.run(v.id, 'thumbnail', prev.thumbnail, row.thumbnail); changes++; }
          if (prev.description !== row.description) { hist.run(v.id, 'description', prev.description, row.description); changes++; }
          if (prev.tags_json !== row.tags_json) { hist.run(v.id, 'tags', prev.tags_json, row.tags_json); changes++; }
        }
        upsert.run(row);
        snap.run(v.id, today(), row.view_count, row.like_count, row.comment_count);
        count++;
      }
    });
    tx(res.items || []);
  }
  db.prepare("UPDATE channels SET last_synced = datetime('now') WHERE id = ?").run(channelId);
  return { synced: count, metadataChanges: changes };
}

export function listVideos(channelId, { format = 'all', sort = 'published_at', dir = 'desc', q = '', limit = 200, offset = 0, from = null, to = null } = {}) {
  const where = ['channel_id = ?'];
  const args = [channelId];
  if (format === 'shorts') where.push('is_short = 1');
  else if (format === 'long') where.push('is_short = 0 AND is_live = 0');
  else if (format === 'live') where.push('is_live = 1');
  if (q) { where.push('(title LIKE ? OR description LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (from) { where.push('published_at >= ?'); args.push(from); }
  if (to) { where.push('published_at <= ?'); args.push(to + 'T23:59:59Z'); }
  const sortCol = ['published_at', 'view_count', 'like_count', 'comment_count', 'duration_sec', 'title'].includes(sort) ? sort : 'published_at';
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  const rows = db.prepare(`SELECT * FROM videos WHERE ${where.join(' AND ')} ORDER BY ${sortCol} ${d} LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM videos WHERE ${where.join(' AND ')}`).get(...args).n;
  return { total, videos: rows.map(hydrateVideo) };
}

export function hydrateVideo(r) {
  return { ...r, tags: r.tags_json ? JSON.parse(r.tags_json) : [], is_short: !!r.is_short, is_live: !!r.is_live };
}

export function getVideo(id) {
  const r = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  return r ? hydrateVideo(r) : null;
}

export async function fetchVideosByIds(ids) {
  const out = [];
  for (const group of chunk(ids, 50)) {
    const res = await ytGet('videos.list', { part: 'snippet,statistics,contentDetails', id: group.join(','), maxResults: 50 }, { ttl: DEFAULT_TTL.videoStats });
    for (const v of res.items || []) {
      const dur = parseDuration(v.contentDetails?.duration);
      out.push({
        id: v.id, channel_id: v.snippet?.channelId, channel_title: v.snippet?.channelTitle, title: v.snippet?.title, description: v.snippet?.description,
        tags: v.snippet?.tags || [], published_at: v.snippet?.publishedAt, duration_sec: dur, is_short: isShort(dur, v.snippet?.title, v.snippet?.description),
        thumbnail: bestThumb(v.snippet?.thumbnails), view_count: Number(v.statistics?.viewCount || 0), like_count: Number(v.statistics?.likeCount || 0),
        comment_count: Number(v.statistics?.commentCount || 0), category_id: v.snippet?.categoryId,
      });
    }
  }
  return out;
}

export async function fetchChannelsByIds(ids) {
  const out = [];
  for (const group of chunk(ids, 50)) {
    const res = await ytGet('channels.list', { part: 'snippet,statistics,contentDetails', id: group.join(','), maxResults: 50 }, { ttl: DEFAULT_TTL.channel });
    for (const it of res.items || []) out.push(channelFromResource(it));
  }
  return out;
}

export function channelHistory(channelId, days = 90) {
  return db.prepare(`SELECT day, views, subs, videos FROM snapshots WHERE entity_type='channel' AND entity_id = ? AND day >= date('now', ?) ORDER BY day`).all(channelId, `-${days} days`);
}

export function videoHistory(videoId, days = 90) {
  return db.prepare(`SELECT day, views, likes, comments FROM snapshots WHERE entity_type='video' AND entity_id = ? AND day >= date('now', ?) ORDER BY day`).all(videoId, `-${days} days`);
}

export function metadataHistory(videoId) {
  return db.prepare('SELECT * FROM metadata_history WHERE video_id = ? ORDER BY observed_at DESC').all(videoId);
}

export { isAuthorized };
