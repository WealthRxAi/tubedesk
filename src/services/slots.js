// Best publish slots per channel, learned from which slots your own uploads performed best in. The YouTube API
// has no hour-by-hour "when your viewers are online" data, so this uses each upload's result against its local
// baseline (the radar's outcome measure) grouped by local weekday and 3-hour block, shrunk toward neutral when
// a slot has few uploads. Used by publish "publishAt: best" and by the Shorts scheduler.
import { db, getSetting } from '../db.js';
import { buildCorpus } from './radar.js';
import { mean } from './stats.js';

export const tz = () => getSetting('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone);
const DAY = 86400000, HOUR = 3600000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Local weekday (0-6) and hour (0-23) of an instant in the configured time zone. */
export function localParts(ms, zone = tz()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { dow: DOW.indexOf(p.weekday), hour: Number(p.hour) % 24, minute: Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}
/** UTC instant for a local wall-clock time (date YYYY-MM-DD, hour) in the zone — handles daylight saving. */
export function zonedInstant(date, hour, zone = tz()) {
  const [y, m, d] = date.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, zone);
    const diff = (p.hour - hour) * HOUR + (p.date === date ? 0 : (p.date < date ? -DAY : DAY));
    if (!diff && p.minute === 0) break;
    guess -= diff + p.minute * 60000;
  }
  return guess;
}

/** Slot effects from history: weekday + 3-hour block, in log2 units vs the channel baseline. */
export function slotModel(channelId, { format = null } = {}) {
  const zone = tz();
  const corpus = buildCorpus(channelId).filter(r => r.own && r.y !== null);
  let rows = format ? corpus.filter(r => r.is_short === (format === 'short')) : corpus;
  if (rows.length < 8) rows = corpus; // too few of this format: use all uploads
  const K = 4; // shrinkage: a slot needs ~4 uploads to count fully
  const agg = (keyFn) => {
    const g = {};
    for (const r of rows) { const k = keyFn(r); (g[k] ||= []).push(r.y); }
    return Object.fromEntries(Object.entries(g).map(([k, ys]) => [k, { n: ys.length, effect: (mean(ys) * ys.length) / (ys.length + K) }]));
  };
  const parts = r => localParts(r.ts, zone);
  const byBlock = agg(r => Math.floor(parts(r).hour / 3));
  const byDow = agg(r => parts(r).dow);
  // Most common historic upload hour per block (so we pick a familiar time inside a good block).
  const hourCounts = {};
  for (const r of rows) { const h = parts(r).hour; hourCounts[h] = (hourCounts[h] || 0) + 1; }
  return { n: rows.length, byBlock, byDow, hourCounts, zone, format: format || 'all' };
}

/**
 * Next `count` publish slots, ≥ minGapHours apart, at least leadMinutes from now, avoiding slots already taken
 * (scheduled uploads in the publish queue). Returns [{at, local, expectedX, source}].
 */
const nextDate = (date, n) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

export function bestSlots(channelId, { format = null, count = 3, from = Date.now(), minGapHours = 20, leadMinutes = 120, days = 10, exclude = {} } = {}) {
  const m = slotModel(channelId, { format });
  const zone = m.zone;
  const taken = takenSlots(channelId, exclude);
  const enough = m.n >= 8;
  // never 0–6 am local, even if the setting asks for it
  const fallbackHour = Math.min(23, Math.max(6, Math.round(Number(getSetting('default_publish_hour', 15)) || 15)));
  const cands = [];
  const firstDate = localParts(from, zone).date;
  for (let d = 0; d < days; d++) {
    const date = nextDate(firstDate, d); // step calendar dates, not 24 h, so daylight-saving days aren't skipped
    for (let block = 0; block < 8; block++) {
      if (block < 2) continue; // never schedule between midnight and 6 am local
      const hoursInBlock = [block * 3, block * 3 + 1, block * 3 + 2];
      const hour = enough ? hoursInBlock.sort((a, b) => (m.hourCounts[b] || 0) - (m.hourCounts[a] || 0))[0] : fallbackHour;
      if (!enough && block !== Math.floor(fallbackHour / 3)) continue;
      const at = zonedInstant(date, hour, zone);
      if (at < from + leadMinutes * 60000) continue;
      const dow = localParts(at, zone).dow;
      const effect = enough ? (m.byBlock[block]?.effect || 0) + (m.byDow[dow]?.effect || 0) : 0;
      cands.push({ at, effect, block, dow });
    }
  }
  cands.sort((a, b) => b.effect - a.effect || a.at - b.at);
  const out = [];
  for (const c of cands) {
    if (out.length >= count) break;
    if ([...out.map(o => o.at), ...taken].some(t => Math.abs(t - c.at) < minGapHours * HOUR)) continue;
    out.push(c);
  }
  out.sort((a, b) => a.at - b.at);
  return out.map(c => ({
    at: new Date(c.at).toISOString(),
    local: new Date(c.at).toLocaleString('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    expectedX: enough ? +(2 ** c.effect).toFixed(2) : null,
    source: enough ? `your ${m.n} uploads by local weekday and 3-hour block (${zone})` : `not enough history yet (${m.n} uploads) — default ${fallbackHour}:00 ${zone}`,
  }));
}

function takenSlots(channelId, { clipId = null, queueId = null } = {}) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'publish_queue'").get()) return [];
  // Waiting/running items, and done YouTube uploads still private until their publish time, hold their slot.
  const queued = db.prepare("SELECT id, clip_id, publish_at FROM publish_queue WHERE channel_id = ? AND publish_at IS NOT NULL AND (status IN ('waiting', 'running') OR (status = 'done' AND publish_at > ?))").all(channelId, new Date().toISOString())
    .filter(r => !(clipId && r.clip_id === clipId) && r.id !== queueId).map(r => Date.parse(r.publish_at));
  // Uploads already sent to YouTube as private-until-publishAt also hold their slot until it passes.
  let direct = [];
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'publish_jobs'").get()) {
    direct = db.prepare("SELECT params_json FROM publish_jobs WHERE platform = 'youtube' AND status != 'failed' AND created_at >= datetime('now', '-30 days')").all()
      .map(r => { try { const p = JSON.parse(r.params_json); return (!p.channelId || p.channelId === channelId) && p.publishAt ? Date.parse(p.publishAt) : NaN; } catch { return NaN; } })
      .filter(t => Number.isFinite(t) && t > Date.now());
  }
  return [...queued, ...direct];
}

/** Heatmap data for the UI: effect by weekday × block. */
export function slotGrid(channelId, { format = null } = {}) {
  const m = slotModel(channelId, { format });
  return { n: m.n, zone: m.zone, format: m.format,
    blocks: Object.entries(m.byBlock).map(([b, v]) => ({ block: Number(b), label: `${String(b * 3).padStart(2, '0')}–${String(b * 3 + 3).padStart(2, '0')}`, n: v.n, x: +(2 ** v.effect).toFixed(2) })).sort((a, b) => a.block - b.block),
    weekdays: Object.entries(m.byDow).map(([d, v]) => ({ dow: Number(d), label: DOW[d], n: v.n, x: +(2 ** v.effect).toFixed(2) })).sort((a, b) => a.dow - b.dow) };
}
