// Boards, blueprints, saved items, Studio CSV import, earnings calculator, exports, backup, playlists.
import { db } from '../db.js';
import { ytGet, ytWrite } from '../youtube/client.js';
import { hydrateVideo } from './channels.js';

// ---------- Boards (research / inspiration) ----------
export const boards = {
  list: (channelId) => db.prepare('SELECT b.*, (SELECT COUNT(*) FROM board_items i WHERE i.board_id = b.id) AS items FROM boards b WHERE b.channel_id = ? OR b.channel_id IS NULL ORDER BY b.created_at DESC').all(channelId),
  create: (channelId, name) => db.prepare('INSERT INTO boards (channel_id, name) VALUES (?, ?)').run(channelId, name).lastInsertRowid,
  remove: (id) => db.prepare('DELETE FROM boards WHERE id = ?').run(id).changes,
  items: (boardId) => db.prepare('SELECT * FROM board_items WHERE board_id = ? ORDER BY created_at DESC').all(boardId).map(i => ({ ...i, ref: JSON.parse(i.ref_json) })),
  addItem: (boardId, kind, ref, note = '') => db.prepare('INSERT INTO board_items (board_id, kind, ref_json, note) VALUES (?, ?, ?, ?)').run(boardId, kind, JSON.stringify(ref), note).lastInsertRowid,
  updateNote: (itemId, note) => db.prepare('UPDATE board_items SET note = ? WHERE id = ?').run(note, itemId).changes,
  removeItem: (itemId) => db.prepare('DELETE FROM board_items WHERE id = ?').run(itemId).changes,
};

// ---------- Blueprints (one record per video idea: idea → audience → title → thumbnail → proof) ----------
export const blueprints = {
  list: (channelId) => db.prepare('SELECT * FROM blueprints WHERE channel_id = ? ORDER BY updated_at DESC').all(channelId).map(b => ({ ...b, titles: JSON.parse(b.titles_json || '[]') })),
  get: (id) => { const b = db.prepare('SELECT * FROM blueprints WHERE id = ?').get(id); return b ? { ...b, titles: JSON.parse(b.titles_json || '[]') } : null; },
  create: (channelId, data) => db.prepare('INSERT INTO blueprints (channel_id, title, idea, audience, titles_json, thumbnail_notes, proof, outline, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(channelId, data.title || 'Untitled', data.idea || '', data.audience || '', JSON.stringify(data.titles || []), data.thumbnail_notes || '', data.proof || '', data.outline || '', data.status || 'idea').lastInsertRowid,
  update: (id, data) => db.prepare(`UPDATE blueprints SET title = COALESCE(?, title), idea = COALESCE(?, idea), audience = COALESCE(?, audience), titles_json = COALESCE(?, titles_json), thumbnail_notes = COALESCE(?, thumbnail_notes), proof = COALESCE(?, proof), outline = COALESCE(?, outline), status = COALESCE(?, status), updated_at = datetime('now') WHERE id = ?`)
    .run(data.title ?? null, data.idea ?? null, data.audience ?? null, data.titles ? JSON.stringify(data.titles) : null, data.thumbnail_notes ?? null, data.proof ?? null, data.outline ?? null, data.status ?? null, id).changes,
  remove: (id) => db.prepare('DELETE FROM blueprints WHERE id = ?').run(id).changes,
};

export const saved = {
  list: (channelId, kind = null) => db.prepare(`SELECT * FROM saved_items WHERE channel_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY created_at DESC`).all(...(kind ? [channelId, kind] : [channelId])),
  create: (channelId, kind, title, body) => db.prepare('INSERT INTO saved_items (channel_id, kind, title, body) VALUES (?, ?, ?, ?)').run(channelId, kind, title, typeof body === 'string' ? body : JSON.stringify(body)).lastInsertRowid,
  remove: (id) => db.prepare('DELETE FROM saved_items WHERE id = ?').run(id).changes,
};

// ---------- YouTube Studio CSV import (impressions, CTR, AVD — not exposed by any API) ----------
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}

const COLS = {
  video_id: [/^content$/i, /video id/i, /^video$/i],
  video_title: [/video title/i, /^title$/i],
  impressions: [/^impressions$/i],
  ctr: [/impressions click.?through rate/i, /^ctr/i],
  avg_view_duration: [/average view duration/i],
  avg_view_pct: [/average percentage viewed/i],
  views: [/^views$/i],
  watch_hours: [/watch time \(hours\)/i],
};

export function importStudioCsv(channelId, text, periodLabel = '') {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV has no data rows');
  const header = rows[0];
  const idx = {};
  for (const [k, res] of Object.entries(COLS)) idx[k] = header.findIndex(h => res.some(re => re.test(h.trim())));
  if (idx.video_id < 0 && idx.video_title < 0) throw new Error('Could not find a Content / Video title column. Export from YouTube Studio → Analytics → Content → Advanced mode → Export (CSV).');
  const toSec = (v) => { if (!v) return null; const p = String(v).split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : Number(v) || null; };
  const num = (v) => { if (v === undefined || v === null || v === '') return null; const n = Number(String(v).replace(/[%,]/g, '')); return Number.isFinite(n) ? n : null; };
  const ins = db.prepare('INSERT INTO studio_imports (channel_id, video_id, video_title, impressions, ctr, avg_view_duration_sec, avg_view_pct, views, watch_hours, period_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows.slice(1)) {
      const vid = idx.video_id >= 0 ? r[idx.video_id] : null;
      if (vid && /^total$/i.test(vid)) continue;
      const title = idx.video_title >= 0 ? r[idx.video_title] : null;
      if (!vid && !title) continue;
      ins.run(channelId, vid || null, title || null, num(r[idx.impressions]), num(r[idx.ctr]), toSec(r[idx.avg_view_duration]), num(r[idx.avg_view_pct]), num(r[idx.views]), num(r[idx.watch_hours]), periodLabel);
      n++;
    }
  });
  tx();
  return { imported: n, columnsFound: Object.fromEntries(Object.entries(idx).filter(([, v]) => v >= 0).map(([k, v]) => [k, header[v]])) };
}

export function studioData(channelId) {
  const rows = db.prepare('SELECT s.*, v.title AS lib_title, v.thumbnail, v.published_at, v.is_short FROM studio_imports s LEFT JOIN videos v ON v.id = s.video_id WHERE s.channel_id = ? ORDER BY s.imported_at DESC, s.impressions DESC').all(channelId);
  const latest = rows.length ? rows.filter(r => r.imported_at === rows[0].imported_at) : [];
  const withCtr = latest.filter(r => r.ctr !== null && r.impressions);
  const avgCtr = withCtr.length ? withCtr.reduce((a, r) => a + r.ctr * r.impressions, 0) / withCtr.reduce((a, r) => a + r.impressions, 0) : null;
  return { rows: latest, imports: [...new Set(rows.map(r => r.imported_at))].length, impressionWeightedCtr: avgCtr, lowCtrHighImpressions: withCtr.filter(r => r.ctr < (avgCtr || 0) * 0.8).sort((a, b) => b.impressions - a.impressions).slice(0, 15) };
}

// ---------- Earnings / valuation scenario calculators (never asserted as actual) ----------
export const RPM_BANDS = {
  'Finance & investing': [8, 25], 'Business / marketing': [6, 18], 'Technology / software': [5, 14], 'Education & science': [4, 12], 'Health & fitness': [4, 10],
  'Real estate': [6, 16], 'Personal development': [3, 9], 'Travel': [2, 6], 'Food & cooking': [2, 5], 'Gaming': [1, 4], 'Entertainment / vlogs': [1, 4], 'Pets & animals': [1.5, 4], 'Kids & family': [0.5, 2], 'Shorts (any niche)': [0.05, 0.2],
};
export function earningsScenario({ views, niche = 'Education & science', rpmLow = null, rpmHigh = null, monetizedShare = 0.6, sponsorPerVideo = 0, videosPerMonth = 0, affiliateRpm = 0 }) {
  const band = RPM_BANDS[niche] || RPM_BANDS['Education & science'];
  const lo = rpmLow ?? band[0], hi = rpmHigh ?? band[1];
  const v = Number(views) || 0;
  const ad = (rpm) => (v / 1000) * rpm;
  return {
    inputs: { views: v, niche, rpmLow: lo, rpmHigh: hi, monetizedShare, sponsorPerVideo, videosPerMonth, affiliateRpm },
    adRevenue: { low: ad(lo), mid: ad((lo + hi) / 2), high: ad(hi) },
    sponsorships: sponsorPerVideo * videosPerMonth, affiliate: (v / 1000) * affiliateRpm,
    total: { low: ad(lo) + sponsorPerVideo * videosPerMonth + (v / 1000) * affiliateRpm, high: ad(hi) + sponsorPerVideo * videosPerMonth + (v / 1000) * affiliateRpm },
    disclaimer: 'RPM is revenue per 1,000 views after YouTube’s share, already net of non-monetized views in the band. Bands are typical published ranges by niche, not a measurement of your channel. Real figures: YouTube Studio → Revenue, or Analytics → Revenue here if the channel is in YPP.',
  };
}
export function valuationScenario({ monthlyRevenue, growthPct = 0, multipleLow = 24, multipleHigh = 48 }) {
  const m = Number(monthlyRevenue) || 0;
  return { inputs: { monthlyRevenue: m, growthPct, multipleLow, multipleHigh }, low: m * multipleLow, high: m * multipleHigh, disclaimer: 'Scenario only. Channel sale multiples vary widely (commonly 2–4 years of profit for stable channels); this is not a valuation of your channel.' };
}

// ---------- Exports & backup ----------
export function toCsv(rows, columns = null) {
  if (!rows.length) return '';
  const cols = columns || Object.keys(rows[0]);
  const esc = v => { const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

export function channelBackup(channelId) {
  const ch = db.prepare('SELECT id, title, handle, description, country, kind, subscriber_count, view_count, video_count, published_at FROM channels WHERE id = ?').get(channelId);
  const videos = db.prepare('SELECT * FROM videos WHERE channel_id = ? ORDER BY published_at DESC').all(channelId).map(hydrateVideo);
  const history = db.prepare('SELECT * FROM metadata_history WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?) ORDER BY observed_at').all(channelId);
  const snapshots = db.prepare("SELECT * FROM snapshots WHERE (entity_type='channel' AND entity_id = ?) OR (entity_type='video' AND entity_id IN (SELECT id FROM videos WHERE channel_id = ?)) ORDER BY day").all(channelId, channelId);
  const bp = blueprints.list(channelId);
  return { exportedAt: new Date().toISOString(), channel: ch, videos, metadataHistory: history, snapshots, blueprints: bp, savedItems: saved.list(channelId), studioImports: db.prepare('SELECT * FROM studio_imports WHERE channel_id = ?').all(channelId) };
}

// ---------- Playlists (owner-authorized) ----------
export async function listPlaylists(channelId, { owned = false } = {}) {
  const params = owned ? { part: 'snippet,contentDetails,status', mine: true, maxResults: 50 } : { part: 'snippet,contentDetails', channelId, maxResults: 50 };
  const res = await ytGet('playlists.list', params, { ttl: 3600, channelId: owned ? channelId : null });
  return (res.items || []).map(p => ({ id: p.id, title: p.snippet.title, description: p.snippet.description, count: p.contentDetails?.itemCount, privacy: p.status?.privacyStatus, thumbnail: p.snippet.thumbnails?.medium?.url }));
}
export async function playlistItems(playlistId, channelId = null) {
  const out = []; let pageToken;
  do {
    const res = await ytGet('playlistItems.list', { part: 'snippet,contentDetails', playlistId, maxResults: 50, pageToken }, { ttl: 1800, channelId });
    for (const i of res.items || []) out.push({ id: i.id, videoId: i.contentDetails.videoId, title: i.snippet.title, position: i.snippet.position, published_at: i.contentDetails.videoPublishedAt });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}
export async function createPlaylist(channelId, { title, description = '', privacy = 'public' }) {
  return await ytWrite('playlists.insert', { params: { part: 'snippet,status' }, json: { snippet: { title, description }, status: { privacyStatus: privacy } }, channelId });
}
export async function addToPlaylist(channelId, playlistId, videoId) {
  return await ytWrite('playlistItems.insert', { params: { part: 'snippet' }, json: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } }, channelId });
}

// ---------- Content safety preflight ----------
export const SAFETY_CHECKLIST = [
  { id: 'altered', label: 'Altered or synthetic content disclosed at upload (AI voice, AI footage, realistic edits)', required: true },
  { id: 'mfk', label: 'Made-for-kids setting is accurate (COPPA)', required: true },
  { id: 'music', label: 'Music is licensed or from YouTube Audio Library', required: true },
  { id: 'footage', label: 'Footage/images are owned, licensed, or clearly fair-use with attribution', required: true },
  { id: 'claims', label: 'Factual claims are sourced in the description', required: false },
  { id: 'sponsor', label: 'Paid promotion box ticked if sponsored', required: true },
  { id: 'captions', label: 'Captions reviewed (auto-captions corrected for names/terms)', required: false },
  { id: 'thumb', label: 'Thumbnail does not misrepresent the content', required: true },
  { id: 'medical', label: 'Medical/financial advice carries an appropriate disclaimer', required: false },
];
