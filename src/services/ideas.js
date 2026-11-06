// Daily idea list: every morning, turn fresh evidence (competitor breakouts, your own winners, the search terms that
// bring viewers to you, new autocomplete suggestions) into video ideas, score every title on the virality radar,
// and send the top three to your phone. Ideas always cite the signals they came from.
import { db, getSetting } from '../db.js';
import { getChannel, listChannels } from './channels.js';
import { analyticsQuery, dateRange } from '../youtube/analytics.js';
import { isAuthorized } from '../youtube/oauth.js';
import { risingSuggestions } from './discovery.js';
import { titleSeed } from './packaging.js';
import { scorePackages, buildCorpus, tokens, jaccard, aiAvailable } from './radar.js';
import { median } from './stats.js';
import { notify } from './notify.js';
import * as ai from './ai.js';

db.exec(`
CREATE TABLE IF NOT EXISTS radar_ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  day TEXT NOT NULL,
  rank INTEGER,
  topic TEXT,
  angle TEXT,
  best_title TEXT NOT NULL,
  titles_json TEXT NOT NULL,
  keyword TEXT,
  thumb_text TEXT,
  hook TEXT,
  format TEXT,
  score REAL,
  predicted_x REAL,
  p_breakout REAL,
  band TEXT,
  axes_json TEXT,
  sources_json TEXT,
  status TEXT NOT NULL DEFAULT 'new',   -- new | saved | used | dismissed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ideas_ch_day ON radar_ideas(channel_id, day);
`);

const today = () => new Date().toLocaleDateString('en-CA');

/** Evidence the ideas must be grounded in. Each signal gets an id the AI cites. */
export async function gatherSignals(channelId) {
  const signals = [];
  const now = Date.now();
  // 1. Competitor breakouts in the last 30 days: ≥ 2× that channel's median of its last 30 uploads (same bar as the radar).
  const comps = db.prepare('SELECT c.id, c.title FROM competitor_links l JOIN channels c ON c.id = l.competitor_channel_id WHERE l.owned_channel_id = ?').all(channelId);
  const breakouts = [];
  for (const c of comps) {
    const recent = db.prepare('SELECT id, title, view_count, published_at, is_short FROM videos WHERE channel_id = ? AND is_live = 0 ORDER BY published_at DESC LIMIT 30').all(c.id);
    const med = median(recent.map(v => v.view_count)) || 0;
    if (!med) continue;
    for (const v of recent) {
      const ageD = (now - Date.parse(v.published_at)) / 86400000;
      if (ageD <= 30 && v.view_count / med >= 2) breakouts.push({ id: v.id, title: v.title, channel: c.title, x: v.view_count / med, ageD, short: !!v.is_short });
    }
  }
  breakouts.sort((a, b) => b.x - a.x).slice(0, 8).forEach((b, i) => signals.push({ id: 'C' + (i + 1), type: 'competitor breakout', text: `"${b.title}" — ${b.channel}, ${b.x.toFixed(1)}× their usual views, ${Math.round(b.ageD)} days old${b.short ? ' (Short)' : ''}`, ref: b.id }));
  // 2. Your own winners (local baseline ≥ 1.75×) in the last 180 days — follow-up material.
  const corpus = buildCorpus(channelId);
  corpus.filter(r => r.own && r.y !== null && r.y >= 0.8 && now - r.ts <= 180 * 86400000).sort((a, b) => b.y - a.y).slice(0, 5)
    .forEach((r, i) => signals.push({ id: 'O' + (i + 1), type: 'your winner', text: `"${r.title}" — ${(2 ** r.y).toFixed(1)}× your usual views`, ref: r.id }));
  // 3. Real YouTube search terms that brought viewers to the channel (owner Analytics).
  if (isAuthorized(channelId)) {
    try {
      const r = await analyticsQuery(channelId, { ...dateRange(28), metrics: 'views', dimensions: 'insightTrafficSourceDetail', filters: 'insightTrafficSourceType==YT_SEARCH', sort: '-views', maxResults: 15, ttl: 12 * 3600 });
      r.rows.slice(0, 10).forEach((t, i) => signals.push({ id: 'S' + (i + 1), type: 'search term bringing you viewers', text: `"${t.insightTrafficSourceDetail}" — ${t.views} views in 28 days` }));
    } catch { /* analytics optional */ }
  }
  // 4. New autocomplete suggestions since the last check, seeded from your strongest topics.
  const seeds = [...new Set(corpus.filter(r => r.own && r.y !== null).sort((a, b) => b.y - a.y).slice(0, 3).map(r => titleSeed(r.title)).filter(Boolean))].slice(0, 2);
  let n = 0;
  for (const seed of seeds) {
    try {
      const r = await risingSuggestions(seed, { country: getSetting('default_country', 'US') });
      for (const sug of (r.newSuggestions.length ? r.newSuggestions : r.current).slice(0, 4)) signals.push({ id: 'A' + (++n), type: r.newSuggestions.length ? 'new autocomplete suggestion' : 'autocomplete suggestion', text: `"${sug}"` });
    } catch { /* suggest optional */ }
  }
  const covered = corpus.filter(r => r.own).sort((a, b) => b.ts - a.ts).slice(0, 25).map(r => r.title);
  return { signals, covered };
}

/** Generate, score and store today's ideas for one owned channel. */
export async function runDaily(channelId, { count = Number(getSetting('ideas_count', 8)), notifyPhone = true } = {}) {
  const ch = getChannel(channelId);
  if (!ch) throw Object.assign(new Error('Unknown channel'), { status: 404 });
  if (!aiAvailable()) throw Object.assign(new Error('The daily idea list needs the AI provider (Settings → AI).'), { status: 400 });
  const { signals, covered } = await gatherSignals(channelId);
  if (!signals.length) throw Object.assign(new Error('No signals yet: sync your library and track a few competitors first.'), { status: 400 });
  const prompt = `You are the content strategist for the YouTube channel "${ch.title}" (${String(ch.description || '').replace(/\s+/g, ' ').slice(0, 300)}).
Propose ${count} video ideas for this channel, grounded ONLY in these signals:
${signals.map(s => `[${s.id}] ${s.type}: ${s.text}`).join('\n')}

Recently covered by this channel (do not repeat these):
${covered.map(t => '- ' + t).join('\n') || '- nothing yet'}

Rules: every idea cites at least one signal id in "sources"; never copy a competitor's title — find the angle they missed or make a stronger, honest promise; three different title options per idea, each under 60 characters; "hook" is the first two sentences of the video; "thumbText" is 2-4 words that complement the best title; "format" is "long" or "short".
Return JSON: {"ideas":[{"topic":"...","angle":"why this, why now — one sentence","titles":["...","...","..."],"keyword":"...","thumbText":"...","hook":"...","format":"long","sources":["C1"]}]}`;
  const out = await ai.ask('daily_ideas', prompt, { json: true });
  let ideas = (out.ideas || []).filter(i => Array.isArray(i.titles) && i.titles.some(t => String(t).trim())).slice(0, count);
  // Drop near-repeats of ideas from the last 14 days.
  const recent = db.prepare("SELECT best_title FROM radar_ideas WHERE channel_id = ? AND day >= date('now', '-14 days')").all(channelId).map(r => tokens(r.best_title));
  ideas = ideas.filter(i => !recent.some(t => i.titles.some(x => jaccard(tokens(x), t) >= 0.6)));
  const scored = [];
  const corpus = buildCorpus(channelId);
  for (const format of ['long', 'short']) {
    const group = ideas.map((idea, i) => ({ idea, i })).filter(x => (x.idea.format === 'short' ? 'short' : 'long') === format);
    if (!group.length) continue;
    const packages = group.flatMap(({ idea, i }) => idea.titles.slice(0, 3).map((t, j) => ({ key: `${i}-${j}`, title: String(t).trim().slice(0, 100), keyword: idea.keyword || '', hook: idea.hook || null })));
    const { results } = await scorePackages(channelId, packages, { format, corpus });
    for (const { idea, i } of group) {
      const titles = idea.titles.slice(0, 3).map((t, j) => results[`${i}-${j}`]).filter(Boolean).map(r => ({ title: r.title, score: r.score, prediction: r.prediction, axes: r.axes }));
      titles.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      if (titles.length) scored.push({ idea, format, titles, best: titles[0] });
    }
  }
  scored.sort((a, b) => (b.best.score ?? -1) - (a.best.score ?? -1));
  const day = today();
  const sigById = Object.fromEntries(signals.map(s => [s.id, s]));
  const ins = db.prepare(`INSERT INTO radar_ideas (channel_id, day, rank, topic, angle, best_title, titles_json, keyword, thumb_text, hook, format, score, predicted_x, p_breakout, band, axes_json, sources_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rows = scored.map((s, k) => ins.run(channelId, day, k + 1, s.idea.topic || '', s.idea.angle || '', s.best.title, JSON.stringify(s.titles), s.idea.keyword || '', s.idea.thumbText || '', s.idea.hook || '', s.format,
    s.best.score, s.best.prediction?.multiplier ?? null, s.best.prediction?.pBreakout ?? null, s.best.prediction?.band ?? null, JSON.stringify(s.best.axes),
    JSON.stringify((s.idea.sources || []).map(id => sigById[id]).filter(Boolean))).lastInsertRowid);
  const list = rows.map(get);
  if (notifyPhone && list.length) {
    notify({ kind: 'ideas_daily', title: `Today's top ideas for ${ch.title}`, body: list.slice(0, 3).map((x, i) => `${i + 1}. ${x.best_title} — radar ${x.score ?? '—'}${x.predicted_x ? `, ~${x.predicted_x}× usual` : ''}`).join('\n') }).catch(() => {});
  }
  return { day, channelId, signals: signals.length, ideas: list };
}

export async function runAll() {
  const out = [];
  for (const ch of listChannels('owned')) {
    try { const r = await runDaily(ch.id); out.push({ channel: ch.title, ideas: r.ideas.length }); }
    catch (e) { out.push({ channel: ch.title, error: e.message }); }
  }
  return out;
}

export function get(id) {
  const r = db.prepare('SELECT * FROM radar_ideas WHERE id = ?').get(id);
  return r && { ...r, titles: JSON.parse(r.titles_json), axes: JSON.parse(r.axes_json || 'null'), sources: JSON.parse(r.sources_json || '[]'), titles_json: undefined, axes_json: undefined, sources_json: undefined };
}
export function list(channelId, { days = 14, status = null } = {}) {
  const rows = db.prepare(`SELECT id FROM radar_ideas WHERE channel_id = ? AND day >= date('now', ?) ${status ? 'AND status = ?' : "AND status != 'dismissed'"} ORDER BY day DESC, rank`)
    .all(...[channelId, `-${days} days`, ...(status ? [status] : [])]);
  return rows.map(r => get(r.id));
}
export function setStatus(id, status) {
  if (!['new', 'saved', 'used', 'dismissed'].includes(status)) throw Object.assign(new Error('bad status'), { status: 400 });
  return db.prepare('UPDATE radar_ideas SET status = ? WHERE id = ?').run(status, id).changes;
}
