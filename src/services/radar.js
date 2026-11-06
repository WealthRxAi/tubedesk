// Virality Radar.
//  1. Score a video package (title variants, thumbnail, opening hook, topic) on 8 axes BEFORE publishing.
//  2. Calibrate the axis weights against this channel's own results (backtest with a time-ordered holdout),
//     so the score learns what actually moves views here instead of trusting generic rules.
//  3. Watch every new upload (yours and tracked competitors') hour by hour against your normal launch curve
//     and raise breakout / lagging alerts while there is still time to act.
// Every number exposes its inputs. Nothing here claims to know YouTube's algorithm; the prediction is a
// calibrated range from your own history, and the app says how good that calibration is.
import path from 'node:path';
import { db, getSetting, DATA_DIR } from '../db.js';
import { ytGet } from '../youtube/client.js';
import { analyticsQuery, dateRange } from '../youtube/analytics.js';
import { fetchVideosByIds, getChannel, listChannels } from './channels.js';
import { analyzeTitle, downloadImage, assertThumbPath, titleSeed } from './packaging.js';
import { formatLabel } from './discovery.js';
import { demandIndex } from './scores.js';
import { addAlert } from './competitors.js';
import { median, mean, clamp } from './stats.js';
import * as ai from './ai.js';
import * as reach from './reach.js';
import { flushHeld } from './notify.js';

db.exec(`
CREATE TABLE IF NOT EXISTS radar_features (
  video_id TEXT NOT NULL,
  version TEXT NOT NULL,
  axes_json TEXT NOT NULL,       -- {curiosity, emotion, thumbnail}
  why TEXT,
  fix TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (video_id, version)
);
CREATE TABLE IF NOT EXISTS radar_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  n_train INTEGER,
  weights_json TEXT NOT NULL,
  map_json TEXT NOT NULL,
  axes_json TEXT,
  metrics_json TEXT,
  settings_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_radar_models_ch ON radar_models(channel_id, id);
CREATE TABLE IF NOT EXISTS radar_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  channel_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  title TEXT NOT NULL,
  thumbnail TEXT,
  hook TEXT,
  keyword TEXT,
  format TEXT,
  axes_json TEXT NOT NULL,
  composite REAL,
  coverage REAL,
  predicted_x REAL,
  p_breakout REAL,
  band TEXT,
  model_id INTEGER,
  rank INTEGER,
  video_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_radar_scores_ch ON radar_scores(channel_id, created_at);
CREATE TABLE IF NOT EXISTS radar_watch (
  video_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- owned | competitor
  owner_channel_id TEXT,         -- the owned workspace this competitor video is watched for
  title TEXT,
  thumbnail TEXT,
  published_at TEXT,
  is_short INTEGER DEFAULT 0,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_tick TEXT,
  age_hours REAL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  expected REAL,
  idx REAL,
  peak_idx REAL,
  status TEXT,
  baseline_source TEXT,
  confidence TEXT,
  retention_pct REAL,
  retention_vs_channel REAL,
  alerted_breakout INTEGER DEFAULT 0,
  alerted_lagging INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_radar_watch_ch ON radar_watch(channel_id, published_at);
CREATE TABLE IF NOT EXISTS radar_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  age_hours REAL NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER
);
CREATE INDEX IF NOT EXISTS idx_radar_ticks_video ON radar_ticks(video_id, age_hours);
`);

for (const [col, type] of [['ctr', 'REAL'], ['ctr_vs_channel', 'REAL'], ['impressions', 'INTEGER'], ['autopilot_note', 'TEXT']]) {
  if (!db.prepare('PRAGMA table_info(radar_watch)').all().some(c => c.name === col)) db.exec(`ALTER TABLE radar_watch ADD COLUMN ${col} ${type}`);
}

const FEATURE_VERSION = 'v1';
const HOUR = 3600000, DAY = 86400000;

// ---------- the 8 axes ----------
export const AXES = {
  demand: { label: 'Topic demand', source: 'live', prior: 0.15, backtest: false,
    desc: 'Free YouTube autocomplete signals for the topic (Demand Index). Live-only: autocomplete today reflects demand that old videos may have created, so it is never fitted on history and keeps its prior weight.' },
  patternFit: { label: 'Proven-pattern fit', source: 'data', prior: 0.20, backtest: true,
    desc: 'How videos with overlapping topics and the same format performed against their own channel baseline (your library plus tracked competitors). Leakage-free in backtests: only videos published earlier are used.' },
  freshness: { label: 'Freshness', source: 'data', prior: 0.10, backtest: true,
    desc: 'How saturated the topic is: title overlap with uploads from you and tracked competitors in the last 90 days. Repeating your own recent video caps this at 25.' },
  titleCraft: { label: 'Title craft', source: 'heuristic', prior: 0.10, backtest: true,
    desc: 'The Packaging title checklist (length, hook-first, specificity, stakes, no clickbait punctuation).' },
  curiosity: { label: 'Curiosity gap', source: 'ai', prior: 0.15, backtest: true,
    desc: 'AI rating: does the title + thumbnail open a specific, credible loop the viewer needs closed?' },
  emotion: { label: 'Emotional pull', source: 'ai', prior: 0.10, backtest: true,
    desc: 'AI rating: strength of a felt reaction (surprise, fear, awe, anger, amusement, relief) or high personal stakes for the audience.' },
  thumbnail: { label: 'Thumbnail', source: 'ai-vision', prior: 0.12, backtest: true,
    desc: 'AI vision rating: one focal point, legible at 160 px, strong contrast, complements rather than repeats the title.' },
  hook: { label: 'Opening hook', source: 'ai', prior: 0.08, backtest: false,
    desc: 'AI rating of the first ~30 seconds of script: promise restated immediately, stakes, no throat-clearing. Not backtestable (old transcripts cost 200 quota units each), so it keeps its prior weight.' },
};
const AXIS_KEYS = Object.keys(AXES);
export const DEFAULT_MAP = { alpha: 0, beta: 1.5, sigma: 1.1, n: 0 };

const ADVICE = {
  demand: 'Few people are typing this topic. Re-angle it toward a phrase that autocompletes (Keywords → Explore), or treat it as a browse-only bet that lives on packaging alone.',
  patternFit: 'This topic/format has not worked for you or your tracked peers. Tie it to a theme from your breakouts, or use a format that has beaten your baseline.',
  freshness: 'This was covered recently by you or a tracked channel. Find the angle they missed, or wait for it to cool down.',
  titleCraft: 'The title fails basic packaging checks — see the failed checks below.',
  curiosity: 'The package does not open a loop. Hint at a specific result, contradiction or consequence the viewer has to click to resolve.',
  emotion: 'Low felt stakes. Make the cost of not watching concrete for this audience (money, time, risk, status, surprise).',
  thumbnail: 'The thumbnail is weak at small size. One focal point, 3 words max, high contrast, and show what the title only hints at.',
  hook: 'The opening wastes time. Restate the promise in the first sentence and show proof or stakes before any intro.',
};

// ---------- text helpers ----------
const STOP = new Set(('the and for with this that you your yours how what why when where which who whom are was were will would can could should from into onto about '
  + 'have has had not but all just its our ours out get got one new video videos part shorts short more most than they them their there here been being does did doing '
  + 'make made really very much many some any every each also only even still then than too over under after before again off down upon while ever never always '
  + 'his her hers him she him himself herself itself myself yourself ourselves themselves let lets i\'m you\'re don\'t can\'t won\'t isn\'t').split(/\s+/));

export function tokens(title) {
  const words = String(title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  const out = new Set();
  for (let w of words) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
const normTitle = t => [...tokens(t)].sort().join(' ');

// ---------- statistics ----------
function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
export function pearson(a, b) {
  const n = a.length; if (n < 3) return null;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; dbb += (b[i] - mb) ** 2; }
  return da && dbb ? num / Math.sqrt(da * dbb) : 0;
}
export function spearman(a, b) { return a.length < 3 ? null : pearson(ranks(a), ranks(b)); }
function erf(x) { // Abramowitz–Stegun 7.1.26
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));
const round = (x, d = 2) => x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;

// ---------- corpus with local-baseline labels ----------
/**
 * Every synced video of the owned channel and its linked competitors, each labelled with
 * y = log2(views ÷ median views of its 10 nearest-in-time same-format uploads on the same channel).
 * A local baseline (not the all-time median) absorbs channel growth; videos younger than minAgeDays
 * are unlabelled because their views are still climbing.
 */
export function buildCorpus(channelId, { minAgeDays = Number(getSetting('radar_min_age_days', 14)), neighbors = 10 } = {}) {
  const compIds = db.prepare('SELECT competitor_channel_id AS id FROM competitor_links WHERE owned_channel_id = ?').all(channelId).map(r => r.id);
  const ids = [channelId, ...compIds];
  const rows = db.prepare(`SELECT v.id, v.channel_id, v.title, v.published_at, v.is_short, v.view_count, v.thumbnail, c.title AS channel_title
    FROM videos v JOIN channels c ON c.id = v.channel_id WHERE v.channel_id IN (${ids.map(() => '?').join(',')}) AND v.is_live = 0 AND v.published_at IS NOT NULL ORDER BY v.published_at`).all(...ids);
  const now = Date.now();
  const out = rows.map(r => ({
    ...r, is_short: !!r.is_short, ts: Date.parse(r.published_at), own: r.channel_id === channelId,
    tok: tokens(r.title), format: formatLabel(r.title), ageDays: (now - Date.parse(r.published_at)) / DAY, y: null, baseline: null,
  }));
  const groups = {};
  for (const r of out) (groups[r.channel_id + (r.is_short ? ':s' : ':l')] ||= []).push(r);
  for (const g of Object.values(groups)) {
    const mature = g.filter(r => r.ageDays >= minAgeDays);
    for (let i = 0; i < mature.length; i++) {
      const nb = []; let lo = i - 1, hi = i + 1;
      while (nb.length < neighbors && (lo >= 0 || hi < mature.length)) {
        const dl = lo >= 0 ? mature[i].ts - mature[lo].ts : Infinity;
        const dh = hi < mature.length ? mature[hi].ts - mature[i].ts : Infinity;
        if (dl <= dh) nb.push(mature[lo--]); else nb.push(mature[hi++]);
      }
      if (nb.length < 4) continue;
      const b = median(nb.map(x => x.view_count));
      if (b > 0) { mature[i].baseline = b; mature[i].y = clamp(Math.log2(Math.max(1, mature[i].view_count) / b), -5, 5); }
    }
  }
  return out;
}

// ---------- deterministic axes ----------
export function patternFitAxis(tok, fmt, corpus, { beforeTs = Infinity, isShort = null } = {}) {
  const prior = corpus.filter(r => r.y !== null && r.ts < beforeTs && (isShort === null || r.is_short === isShort));
  const sims = prior.map(r => ({ r, s: jaccard(tok, r.tok) })).filter(x => x.s >= 0.15).sort((a, b) => b.s - a.s).slice(0, 15);
  const wsum = sims.reduce((a, x) => a + x.s, 0);
  const topic = wsum >= 0.3 ? sims.reduce((a, x) => a + x.s * x.r.y, 0) / wsum : null;
  const sameFmt = prior.filter(r => r.format === fmt);
  const format = sameFmt.length >= 3 ? mean(sameFmt.map(r => r.y)) : null;
  if (topic === null && format === null) return null;
  const raw = topic !== null && format !== null ? 0.6 * topic + 0.4 * format : (topic ?? format);
  return {
    value: Math.round(clamp(50 + 25 * raw, 0, 100)),
    detail: {
      topicMultiplier: topic === null ? null : round(2 ** topic), formatMultiplier: format === null ? null : round(2 ** format), format: fmt, formatSample: sameFmt.length,
      similar: sims.slice(0, 5).map(x => ({ id: x.r.id, title: x.r.title, channel: x.r.channel_title, own: x.r.own, similarity: round(x.s), multiplier: round(2 ** x.r.y) })),
    },
  };
}

export function freshnessAxis(tok, corpus, { atTs = Date.now(), selfChannelId = null } = {}) {
  if (!tok.size) return null;
  const windowRows = corpus.filter(r => r.ts < atTs && r.ts >= atTs - 90 * DAY);
  let maxSim = 0, near = 0, ownDup = null, closest = null;
  for (const r of windowRows) {
    const s = jaccard(tok, r.tok);
    if (s > maxSim) { maxSim = s; closest = r; }
    if (s >= 0.35) near++;
    if (r.channel_id === selfChannelId && s >= 0.5 && (!ownDup || s > ownDup.s)) ownDup = { id: r.id, title: r.title, s };
  }
  let v = 100 - 60 * maxSim - 8 * near;
  if (ownDup) v = Math.min(v, 25);
  return {
    value: Math.round(clamp(v, 0, 100)),
    detail: { maxSimilarity: round(maxSim), similarRecentUploads: near, uploadsChecked: windowRows.length,
      closest: closest && maxSim >= 0.2 ? { id: closest.id, title: closest.title, channel: closest.channel_title, similarity: round(maxSim) } : null,
      ownDuplicate: ownDup ? { id: ownDup.id, title: ownDup.title, similarity: round(ownDup.s) } : null },
  };
}

// ---------- AI axes (batched; one call rates up to 6 packages) ----------
export function aiAvailable() { return ai.aiProvider() !== 'none'; }

/** items: [{key, title, image (local file) | null, hook | null}] → {key: {curiosity, emotion, thumbnail, hook, why, fix}} */
export async function aiAxes(items, { context = '' } = {}) {
  let imageNo = 0;
  const images = [];
  const blocks = items.map(it => {
    let thumb = 'none';
    if (it.image) { images.push(it.image); thumb = `image ${++imageNo}`; }
    return `ITEM key=${it.key}\nTitle: ${it.title}\nThumbnail: ${thumb}\nOpening hook: ${it.hook ? '"""' + String(it.hook).slice(0, 900) + '"""' : 'none'}`;
  });
  const prompt = `Rate each YouTube package below for its potential to earn clicks and shares from its intended audience.
${context ? 'Channel context: ' + context + '\n' : ''}Rate every item independently, 0-100, using the full range (a typical upload is about 50, 85+ is rare):
- curiosity: does the title together with the thumbnail open a specific, credible loop the viewer needs closed? Vague teasing or obvious answers score low.
- emotion: strength of the felt reaction it triggers in this audience (surprise, fear, awe, anger, amusement, relief) or concrete personal stakes.
- thumbnail: only when an image is given — one clear focal point, legible at 160 px wide, strong contrast, complements rather than repeats the title. null if no image.
- hook: only when an opening hook is given — promise restated in the first sentence, stakes or proof early, no greetings or channel intro. null if none.
Ignore channel size, popularity or any knowledge of how the video actually performed. Judge only what is shown.

${blocks.join('\n\n')}

Return JSON: {"items":[{"key":"<key>","curiosity":0,"emotion":0,"thumbnail":null,"hook":null,"why":"one short sentence on the biggest strength or weakness","fix":"one concrete change that would raise the weakest rating"}]}`;
  const out = await ai.ask('radar_axes', prompt, { json: true, imagePaths: images });
  const list = Array.isArray(out) ? out : out.items || [];
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Math.round(clamp(Number(v), 0, 100));
  const res = {};
  for (const it of items) {
    const r = list.find(x => String(x.key) === String(it.key)) || null;
    if (!r) continue;
    res[it.key] = { curiosity: num(r.curiosity), emotion: num(r.emotion), thumbnail: it.image ? num(r.thumbnail) : null, hook: it.hook ? num(r.hook) : null, why: r.why ? String(r.why).slice(0, 300) : null, fix: r.fix ? String(r.fix).slice(0, 300) : null };
  }
  return res;
}

export async function localImage({ thumbnailPath, thumbnailUrl }) {
  if (thumbnailPath) return assertThumbPath(thumbnailPath);
  if (!thumbnailUrl) return null;
  // Images uploaded through TubeDesk are served at /data/thumbs/<name>; read them from disk instead of over HTTP.
  if (/^\/data\/thumbs\/[^/]+$/.test(thumbnailUrl)) return assertThumbPath(path.join(DATA_DIR, 'thumbs', path.basename(thumbnailUrl)));
  return await downloadImage(thumbnailUrl);
}

function channelContextLine(channelId) {
  const ch = channelId ? getChannel(channelId) : null;
  return ch ? `${ch.title} — ${(ch.description || '').replace(/\s+/g, ' ').slice(0, 240)}` : '';
}

function loadFeatures(ids) {
  if (!ids.length) return {};
  const out = {};
  const stmt = db.prepare('SELECT * FROM radar_features WHERE video_id = ? AND version = ?');
  for (const id of ids) { const r = stmt.get(id, FEATURE_VERSION); if (r) out[id] = { ...JSON.parse(r.axes_json), why: r.why, fix: r.fix }; }
  return out;
}
function saveFeature(id, f) {
  db.prepare(`INSERT INTO radar_features (video_id, version, axes_json, why, fix) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(video_id, version) DO UPDATE SET axes_json = excluded.axes_json, why = excluded.why, fix = excluded.fix, created_at = datetime('now')`)
    .run(id, FEATURE_VERSION, JSON.stringify({ curiosity: f.curiosity, emotion: f.emotion, thumbnail: f.thumbnail }), f.why, f.fix);
}

/** Compute and cache AI axes for existing videos (title + current thumbnail). Returns {done, failed, errors}. */
export async function featurizeVideos(videos, { context = '', batchSize = 6, onProgress = () => {} } = {}) {
  const cached = loadFeatures(videos.map(v => v.id));
  const todo = videos.filter(v => !cached[v.id]);
  let done = 0, failed = 0, consecutiveFails = 0;
  const errors = [];
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const items = [];
    for (const v of batch) {
      let image = null;
      if (v.thumbnail) { try { image = await downloadImage(v.thumbnail); } catch { image = null; } }
      items.push({ key: v.id, title: v.title, image, hook: null });
    }
    try {
      const r = await aiAxes(items, { context });
      for (const v of batch) { if (r[v.id]) { saveFeature(v.id, r[v.id]); done++; } else failed++; }
      consecutiveFails = 0;
    } catch (e) {
      failed += batch.length; errors.push(e.message); consecutiveFails++;
      if (consecutiveFails >= 2) { errors.push('Stopped after two failed AI batches in a row.'); break; }
    }
    onProgress({ done: done + Object.keys(cached).length, failed, total: videos.length });
  }
  return { cached: Object.keys(cached).length, done, failed, errors };
}

// ---------- model ----------
export function composite(axes, weights) {
  let ws = 0, s = 0, all = 0;
  for (const k of AXIS_KEYS) {
    const w = weights[k] ?? 0; all += w;
    if (Number.isFinite(axes[k])) { ws += w; s += w * axes[k]; }
  }
  return { score: ws > 0 ? s / ws : null, coverage: all > 0 ? ws / all : 0 };
}

export function predict(score, map = DEFAULT_MAP) {
  if (score === null) return null;
  const yhat = map.alpha + map.beta * (score - 50) / 50;
  const sigma = Math.max(0.35, map.sigma || DEFAULT_MAP.sigma);
  const pBreakout = 1 - normCdf((1 - yhat) / sigma);
  const pAbove = 1 - normCdf((0 - yhat) / sigma);
  const mult = 2 ** yhat;
  const band = pBreakout >= 0.35 ? 'Breakout potential' : mult >= 1.25 ? 'Above baseline' : mult >= 0.8 ? 'Typical' : 'Below baseline';
  return { multiplier: round(mult), range80: [round(2 ** (yhat - 1.2816 * sigma)), round(2 ** (yhat + 1.2816 * sigma))], pBreakout: round(pBreakout, 3), pAboveBaseline: round(pAbove, 3), band };
}

export function defaultWeights() { return Object.fromEntries(AXIS_KEYS.map(k => [k, AXES[k].prior])); }

/**
 * Fit axis weights and the score → multiplier map on labelled rows [{axes, y}].
 * Weight per backtestable axis = shrinkage blend of its data share (positive Spearman ρ with outcome) and its prior,
 * λ = n / (n + shrink). Axes with no evidence keep their prior. The map is OLS of y on (score − 50)/50, slope ≥ 0.
 */
export function fitModel(rows, { shrink = 40 } = {}) {
  const priorW = defaultWeights();
  const axisStats = {};
  for (const k of AXIS_KEYS) {
    if (!AXES[k].backtest) { axisStats[k] = { n: 0, rho: null, note: 'live-only signal, kept at prior weight' }; continue; }
    const pts = rows.filter(r => Number.isFinite(r.axes[k]));
    axisStats[k] = { n: pts.length, rho: pts.length >= 8 ? round(spearman(pts.map(p => p.axes[k]), pts.map(p => p.y)), 3) : null };
  }
  const backtestBudget = AXIS_KEYS.filter(k => AXES[k].backtest).reduce((t, k) => t + priorW[k], 0);
  const posSum = AXIS_KEYS.reduce((t, k) => t + (axisStats[k].rho > 0 ? axisStats[k].rho : 0), 0);
  const weights = {};
  for (const k of AXIS_KEYS) {
    const st = axisStats[k];
    if (!AXES[k].backtest || st.rho === null || posSum === 0) { weights[k] = priorW[k]; continue; }
    const dataShare = (Math.max(0, st.rho) / posSum) * backtestBudget;
    const lambda = st.n / (st.n + shrink);
    weights[k] = lambda * dataShare + (1 - lambda) * priorW[k];
    st.dataWeight = round(dataShare, 3); st.lambda = round(lambda, 3);
  }
  const tot = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  for (const k of AXIS_KEYS) weights[k] = round(weights[k] / tot, 4);

  const pts = rows.map(r => ({ c: composite(r.axes, weights).score, y: r.y })).filter(p => p.c !== null);
  let map = { ...DEFAULT_MAP, n: pts.length, fitted: false };
  if (pts.length >= 10) {
    const t = pts.map(p => (p.c - 50) / 50), y = pts.map(p => p.y);
    const mt = mean(t), my = mean(y);
    const vt = mean(t.map(x => (x - mt) ** 2));
    let beta = vt > 1e-6 ? mean(t.map((x, i) => (x - mt) * (y[i] - my))) / vt : 0;
    const negative = beta < 0;
    beta = Math.max(0, beta);
    const alpha = my - beta * mt;
    const resid = y.map((yy, i) => yy - (alpha + beta * t[i]));
    const sigma = Math.sqrt(mean(resid.map(r => r * r)));
    map = { alpha: round(alpha, 4), beta: round(beta, 4), sigma: round(Math.max(0.35, sigma), 4), n: pts.length, fitted: true, slopeWasNegative: negative };
  }
  return { weights, map, axes: axisStats, noSignal: posSum === 0 };
}

/** Time-ordered holdout: fit on the oldest 70 %, test on the newest 30 %. */
export function holdout(rows, { trainShare = 0.7 } = {}) {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const cut = Math.floor(sorted.length * trainShare);
  const train = sorted.slice(0, cut), test = sorted.slice(cut);
  if (train.length < 10 || test.length < 8) return { available: false, reason: `Need ≥ 10 training and ≥ 8 test videos (have ${train.length}/${test.length}).` };
  const m = fitModel(train);
  const scored = test.map(r => ({ c: composite(r.axes, m.weights).score, y: r.y })).filter(p => p.c !== null);
  const rho = spearman(scored.map(p => p.c), scored.map(p => p.y));
  const yhat = scored.map(p => m.map.alpha + m.map.beta * (p.c - 50) / 50);
  const mae = mean(scored.map((p, i) => Math.abs(p.y - yhat[i])));
  const trainMean = mean(train.map(r => r.y));
  const maeNaive = mean(scored.map(p => Math.abs(p.y - trainMean)));
  const byScore = [...scored].sort((a, b) => b.c - a.c);
  const q = Math.max(2, Math.round(byScore.length / 4));
  const top = byScore.slice(0, q), bottom = byScore.slice(-q);
  const base = scored.filter(p => p.y > 0).length / scored.length;
  const prec = top.filter(p => p.y > 0).length / top.length;
  const breakouts = scored.filter(p => p.y >= 1);
  const topHalf = new Set(byScore.slice(0, Math.ceil(byScore.length / 2)));
  return {
    available: true, train: train.length, test: scored.length,
    spearman: round(rho, 3),
    topQuartileHitRate: round(prec, 3), baseHitRate: round(base, 3), lift: base ? round(prec / base, 2) : null,
    topVsBottomMedianX: round(2 ** median(top.map(p => p.y)) / 2 ** median(bottom.map(p => p.y)), 2),
    breakoutsInTest: breakouts.length, breakoutsInTopHalf: breakouts.filter(p => topHalf.has(p)).length,
    maeLog2: round(mae, 3), maeNaiveLog2: round(maeNaive, 3),
    verdict: rho === null ? 'unknown' : rho >= 0.3 && prec > base ? 'useful' : rho >= 0.12 ? 'weak' : 'not predictive yet',
  };
}

export function currentModel(channelId) {
  const r = channelId ? db.prepare('SELECT * FROM radar_models WHERE channel_id = ? ORDER BY id DESC LIMIT 1').get(channelId) : null;
  if (!r) return { id: null, calibrated: false, weights: defaultWeights(), map: { ...DEFAULT_MAP }, axes: null, metrics: null, createdAt: null, nTrain: 0 };
  return { id: r.id, calibrated: true, weights: JSON.parse(r.weights_json), map: JSON.parse(r.map_json), axes: JSON.parse(r.axes_json || 'null'), metrics: JSON.parse(r.metrics_json || 'null'), settings: JSON.parse(r.settings_json || 'null'), createdAt: r.created_at, nTrain: r.n_train };
}
export function listModels(channelId, limit = 10) {
  return db.prepare('SELECT id, created_at, n_train, metrics_json FROM radar_models WHERE channel_id = ? ORDER BY id DESC LIMIT ?').all(channelId, limit)
    .map(r => { const m = JSON.parse(r.metrics_json || 'null'); if (m) delete m.points; return { id: r.id, createdAt: r.created_at, nTrain: r.n_train, metrics: m }; });
}

/** Backtest the radar on the channel's history (+ tracked competitors) and store a calibrated model. */
export async function calibrate(channelId, { aiLimit = Number(getSetting('radar_ai_limit', 60)), minAgeDays = Number(getSetting('radar_min_age_days', 14)), useAI = true, onProgress = () => {} } = {}) {
  const ch = getChannel(channelId);
  if (!ch) throw Object.assign(new Error('Unknown channel'), { status: 404 });
  const corpus = buildCorpus(channelId, { minAgeDays });
  const labelled = corpus.filter(r => r.y !== null);
  const ownLabelled = labelled.filter(r => r.own).length;
  if (labelled.length < 12) throw Object.assign(new Error(`Calibration needs at least 12 videos older than ${minAgeDays} days with a local baseline (have ${labelled.length}). Sync more of your library or add competitors.`), { status: 400 });
  onProgress({ stage: 'deterministic', done: 0, total: labelled.length });
  const rows = labelled.map(r => ({
    id: r.id, ts: r.ts, y: r.y, own: r.own,
    axes: {
      patternFit: patternFitAxis(r.tok, r.format, corpus, { beforeTs: r.ts, isShort: r.is_short })?.value ?? null,
      freshness: freshnessAxis(r.tok, corpus, { atTs: r.ts, selfChannelId: r.channel_id })?.value ?? null,
      titleCraft: analyzeTitle(r.title).score,
    },
  }));
  let aiReport = { used: false, reason: !useAI ? 'disabled for this run' : 'AI provider is off in Settings' };
  if (useAI && aiAvailable() && aiLimit > 0) {
    // Own videos first (newest first), then competitors — the radar is about your audience.
    const pool = [...labelled].sort((a, b) => (b.own - a.own) || (b.ts - a.ts)).slice(0, aiLimit);
    onProgress({ stage: 'ai', done: 0, total: pool.length });
    const r = await featurizeVideos(pool, { context: channelContextLine(channelId), onProgress: p => onProgress({ stage: 'ai', ...p }) });
    aiReport = { used: true, requested: pool.length, ...r };
  }
  const feats = loadFeatures(rows.map(r => r.id));
  for (const r of rows) { const f = feats[r.id]; if (f) { r.axes.curiosity = f.curiosity; r.axes.emotion = f.emotion; r.axes.thumbnail = f.thumbnail; } }
  onProgress({ stage: 'fit', done: 0, total: 1 });
  const metrics = { holdout: holdout(rows), sample: { labelled: rows.length, own: ownLabelled, competitors: rows.length - ownLabelled, withAI: rows.filter(r => Number.isFinite(r.axes.curiosity)).length }, ai: aiReport, minAgeDays };
  const model = fitModel(rows);
  metrics.noSignal = model.noSignal;
  metrics.points = rows.map(r => ({ id: r.id, score: round(composite(r.axes, model.weights).score, 1), actualX: round(2 ** r.y, 3), own: r.own })).filter(p => p.score !== null);
  db.prepare('INSERT INTO radar_models (channel_id, n_train, weights_json, map_json, axes_json, metrics_json, settings_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(channelId, rows.length, JSON.stringify(model.weights), JSON.stringify(model.map), JSON.stringify(model.axes), JSON.stringify(metrics), JSON.stringify({ aiLimit, minAgeDays, useAI }));
  return currentModel(channelId);
}

// ---------- scoring ----------
function advice(axes, details, ai) {
  const out = [];
  const weak = AXIS_KEYS.filter(k => Number.isFinite(axes[k])).sort((a, b) => axes[a] - axes[b]).slice(0, 3).filter(k => axes[k] < 55);
  for (const k of weak) {
    let text = ADVICE[k];
    if (k === 'titleCraft' && details.titleCraft?.failed?.length) text = 'Title checks failing: ' + details.titleCraft.failed.slice(0, 3).join('; ') + '.';
    if (k === 'freshness' && details.freshness?.ownDuplicate) text = `You already covered this recently ("${details.freshness.ownDuplicate.title}"). Change the angle or the promise so it is not a repeat.`;
    else if (k === 'freshness' && details.freshness?.closest) text = `Close to a recent upload: "${details.freshness.closest.title}" (${details.freshness.closest.channel}). ` + ADVICE.freshness;
    if (k === 'patternFit' && details.patternFit?.similar?.some(s => s.multiplier >= 1.5)) {
      const win = details.patternFit.similar.filter(s => s.multiplier >= 1.5)[0];
      text = `Similar topics are mixed; the one that worked was "${win.title}" (${win.multiplier}×). Borrow its angle.`;
    }
    if (['curiosity', 'emotion', 'thumbnail', 'hook'].includes(k) && ai?.fix) text = ai.fix + ' — ' + ADVICE[k];
    out.push({ axis: k, label: AXES[k].label, value: axes[k], text });
  }
  return out;
}

/**
 * Score any set of packages against one channel. Shared by the Score tab, the daily idea list and the autopilot,
 * so every surface ranks the same way. packages: [{key, title, keyword?, hook?, image? (local file), thumbnail? (display url)}]
 * Returns {results: {key: result}, notes, aiUsed, model}. AI axes are rated in batches of up to 8 packages per call.
 */
export async function scorePackages(channelId, packages, { useAI = true, format = 'long', country = getSetting('default_country', 'US'), corpus = null } = {}) {
  const isShort = format === 'short';
  corpus = corpus || (channelId ? buildCorpus(channelId) : []);
  const model = currentModel(channelId);
  const notes = [];
  const demandByKw = new Map();
  for (const p of packages) {
    const kw = (p.keyword || '').trim() || titleSeed(p.title) || [...tokens(p.title)].slice(0, 3).join(' ');
    p._kw = kw;
    if (!kw || demandByKw.has(kw.toLowerCase())) continue;
    try { const d = await demandIndex(kw, { country }); demandByKw.set(kw.toLowerCase(), { value: d.demandIndex, detail: { keyword: kw, band: d.band, components: d.components, regionsPresent: d.regionsPresent } }); }
    catch (e) { demandByKw.set(kw.toLowerCase(), null); notes.push(`Demand index unavailable for "${kw}": ${e.message}`); }
  }
  let aiRes = {}, aiUsed = false;
  if (useAI && aiAvailable()) {
    const context = channelContextLine(channelId);
    try {
      for (let i = 0; i < packages.length; i += 8) {
        const batch = packages.slice(i, i + 8).map(p => ({ key: p.key, title: p.title, image: p.image || null, hook: p.hook || null }));
        Object.assign(aiRes, await aiAxes(batch, { context }));
      }
      aiUsed = true;
    } catch (e) { notes.push(`AI axes skipped: ${e.message}`); }
  } else notes.push(useAI ? 'AI is off in Settings, so curiosity, emotion, thumbnail and hook are not scored; the composite uses the other axes.' : 'AI axes skipped for this run.');
  if (!channelId) notes.push('No channel selected: proven-pattern fit and freshness need a channel library.');
  const results = {};
  for (const p of packages) {
    const tok = tokens(p.title);
    const demand = demandByKw.get((p._kw || '').toLowerCase()) || null;
    const pf = channelId ? patternFitAxis(tok, formatLabel(p.title), corpus, { isShort }) : null;
    const fr = channelId ? freshnessAxis(tok, corpus, { selfChannelId: channelId }) : null;
    const ta = analyzeTitle(p.title, { keyword: p.keyword || '' });
    const a = aiRes[p.key] || {};
    const axes = {
      demand: demand?.value ?? null, patternFit: pf?.value ?? null, freshness: fr?.value ?? null, titleCraft: ta.score,
      curiosity: a.curiosity ?? null, emotion: a.emotion ?? null, thumbnail: a.thumbnail ?? null, hook: a.hook ?? null,
    };
    const details = { demand: demand?.detail || null, patternFit: pf?.detail || null, freshness: fr?.detail || null, titleCraft: { failed: ta.checks.filter(c => !c.pass).map(c => c.name) } };
    const comp = composite(axes, model.weights);
    results[p.key] = { key: p.key, title: p.title, keyword: p._kw, thumbnail: p.thumbnail || null, axes, details,
      score: comp.score === null ? null : Math.round(comp.score), coverage: round(comp.coverage, 2), prediction: predict(comp.score, model.map),
      ai: aiRes[p.key] ? { why: a.why, fix: a.fix } : null, advice: advice(axes, details, aiRes[p.key]) };
  }
  return { results, notes, aiUsed, model };
}

/**
 * Score one to eight packages for the same video idea and rank them.
 * body: {channelId, variants:[{title, thumbnailUrl?, thumbnailPath?}] | title, thumbnailUrl, thumbnailPath, hook, keyword, format: long|short, ai: bool, save: bool}
 */
export async function scoreIdea(body = {}) {
  const { channelId = null, hook = '', format = 'long', ai: useAI = true, save = true } = body;
  let variants = Array.isArray(body.variants) && body.variants.length ? body.variants : [{ title: body.title, thumbnailUrl: body.thumbnailUrl, thumbnailPath: body.thumbnailPath }];
  variants = variants.map(v => typeof v === 'string' ? { title: v } : v).filter(v => String(v?.title || '').trim()).slice(0, 8)
    .map((v, i) => ({ key: 'v' + (i + 1), title: String(v.title).trim().slice(0, 150), thumbnailUrl: v.thumbnailUrl || null, thumbnailPath: v.thumbnailPath || null }));
  if (!variants.length) throw Object.assign(new Error('At least one title is required.'), { status: 400 });
  const isShort = format === 'short';
  const keyword = String(body.keyword || '').trim() || titleSeed(variants[0].title) || [...tokens(variants[0].title)].slice(0, 3).join(' ');
  const pre = [];
  const packages = [];
  for (const v of variants) {
    let image = null;
    if (useAI && aiAvailable()) { try { image = await localImage(v); } catch (e) { pre.push(`Thumbnail for "${v.title}" could not be loaded: ${e.message}`); } }
    packages.push({ key: v.key, title: v.title, keyword, hook: hook || null, image, thumbnail: v.thumbnailUrl || (v.thumbnailPath ? '/data/thumbs/' + path.basename(String(v.thumbnailPath)) : null) });
  }
  const { results: byKey, notes: scoreNotes, aiUsed, model } = await scorePackages(channelId, packages, { useAI, format, country: body.country || getSetting('default_country', 'US') });
  const notes = [...pre, ...scoreNotes];
  if (!model.calibrated) notes.push('Uncalibrated: weights are the default priors. Run Calibration so the radar learns what moves views on this channel.');
  else if (model.map.beta === 0 || model.metrics?.holdout?.verdict === 'not predictive yet') notes.push('On this channel\'s history the radar score has not yet predicted views (calibration verdict: not predictive yet), so every package gets your usual-views baseline as its prediction. The ranking still compares the packages axis by axis; treat it as a packaging checklist, and recalibrate as more uploads mature.');
  const results = variants.map(v => byKey[v.key]).sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
  results.forEach((r, i) => { r.rank = i + 1; });

  const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  if (save) {
    const ins = db.prepare(`INSERT INTO radar_scores (batch_id, channel_id, title, thumbnail, hook, keyword, format, axes_json, composite, coverage, predicted_x, p_breakout, band, model_id, rank)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of results) {
      const row = ins.run(batchId, channelId, r.title, r.thumbnail, hook ? String(hook).slice(0, 2000) : null, keyword, isShort ? 'short' : 'long', JSON.stringify(r.axes), r.score, r.coverage,
        r.prediction?.multiplier ?? null, r.prediction?.pBreakout ?? null, r.prediction?.band ?? null, model.id, r.rank);
      r.id = row.lastInsertRowid;
    }
  }
  return {
    batchId: save ? batchId : null, channelId, keyword, format: isShort ? 'short' : 'long', aiUsed, notes,
    model: { id: model.id, calibrated: model.calibrated, createdAt: model.createdAt, weights: model.weights, map: model.map, verdict: model.metrics?.holdout?.verdict || null, spearman: model.metrics?.holdout?.spearman ?? null },
    variants: results, best: results[0]?.key || null,
  };
}

/** Radar for an existing synced video: deterministic axes as of its publish date + cached AI axes (if featurized). */
export function scoreExisting(videoId) {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!v) return null;
  const owned = db.prepare("SELECT id FROM channels WHERE id = ? AND kind = 'owned'").get(v.channel_id)?.id
    || db.prepare('SELECT owned_channel_id AS id FROM competitor_links WHERE competitor_channel_id = ?').get(v.channel_id)?.id || v.channel_id;
  const corpus = buildCorpus(owned);
  const me = corpus.find(r => r.id === videoId);
  const ts = Date.parse(v.published_at);
  const tok = tokens(v.title);
  const pf = patternFitAxis(tok, formatLabel(v.title), corpus, { beforeTs: ts, isShort: !!v.is_short });
  const fr = freshnessAxis(tok, corpus, { atTs: ts, selfChannelId: v.channel_id });
  const f = loadFeatures([videoId])[videoId] || {};
  const axes = { demand: null, patternFit: pf?.value ?? null, freshness: fr?.value ?? null, titleCraft: analyzeTitle(v.title).score, curiosity: f.curiosity ?? null, emotion: f.emotion ?? null, thumbnail: f.thumbnail ?? null, hook: null };
  const model = currentModel(owned);
  const comp = composite(axes, model.weights);
  return { videoId, title: v.title, axes, score: comp.score === null ? null : Math.round(comp.score), coverage: round(comp.coverage, 2), prediction: predict(comp.score, model.map),
    actualX: me?.y !== null && me?.y !== undefined ? round(2 ** me.y) : null, baseline: me?.baseline ?? null, ai: f.why ? { why: f.why, fix: f.fix } : null, modelId: model.id,
    note: 'Pattern fit and freshness are computed as of the publish date (only earlier videos count). AI axes appear once the video has been featurized by a calibration run.' };
}

// ---------- live breakout watch ----------
function ticksOf(videoId) { return db.prepare('SELECT age_hours, views FROM radar_ticks WHERE video_id = ? ORDER BY age_hours').all(videoId); }
/** Linear interpolation of a cumulative curve [(age, views)] at age h; (0, 0) is implied. null when h is outside the observed span. */
export function interpAt(points, h, { maxFirst = 36 } = {}) {
  const pts = [{ age: 0, views: 0 }, ...points.filter(p => p.age > 0).sort((a, b) => a.age - b.age)];
  if (pts.length < 2 || h > pts[pts.length - 1].age) return null;
  if (pts[1].age > Math.max(maxFirst, h * 1.5) && h < pts[1].age) return null;
  for (let i = 1; i < pts.length; i++) {
    if (h <= pts[i].age) {
      const a = pts[i - 1], b = pts[i];
      if (b.age - a.age > Math.max(30, h)) return null; // gap too wide to trust
      return a.views + (b.views - a.views) * ((h - a.age) / (b.age - a.age || 1));
    }
  }
  return null;
}

/**
 * Expected views at age h for this channel+format, from the best available history:
 *  1. hourly ticks of earlier watched uploads (≥ 3 peers) — high confidence;
 *  2. daily snapshots of earlier uploads interpolated to the same age (≥ 3 peers) — medium;
 *  3. estimate: peers' current views scaled by (h ÷ age)^0.6 (front-loaded launch curve) — low, labelled.
 */
export function expectedAt(channelId, isShort, h, excludeId = null) {
  const watched = db.prepare('SELECT video_id FROM radar_watch WHERE channel_id = ? AND is_short = ? AND video_id != ? ORDER BY published_at DESC LIMIT 20').all(channelId, isShort ? 1 : 0, excludeId || '');
  const fromTicks = watched.map(w => interpAt(ticksOf(w.video_id).map(t => ({ age: t.age_hours, views: t.views })), h, { maxFirst: 6 })).filter(v => v !== null);
  if (fromTicks.length >= 3) return { expected: median(fromTicks), source: `hourly launch curves of ${fromTicks.length} earlier uploads`, peers: fromTicks.length, confidence: 'high' };
  const peers = db.prepare(`SELECT id, published_at, view_count FROM videos WHERE channel_id = ? AND is_short = ? AND is_live = 0 AND id != ? AND published_at >= datetime('now', '-365 days') ORDER BY published_at DESC LIMIT 40`)
    .all(channelId, isShort ? 1 : 0, excludeId || '');
  const snapStmt = db.prepare("SELECT taken_at, views FROM snapshots WHERE entity_type = 'video' AND entity_id = ? ORDER BY day");
  const fromSnaps = [];
  for (const p of peers) {
    const pub = Date.parse(p.published_at);
    const pts = snapStmt.all(p.id).map(s => ({ age: (Date.parse(s.taken_at.replace(' ', 'T') + (s.taken_at.includes('Z') ? '' : 'Z')) - pub) / HOUR, views: s.views }));
    const v = interpAt(pts, h);
    if (v !== null) fromSnaps.push(v);
  }
  if (fromSnaps.length >= 3) return { expected: median(fromSnaps), source: `daily snapshots of ${fromSnaps.length} earlier uploads at the same age`, peers: fromSnaps.length, confidence: 'medium' };
  const exp = Number(getSetting('radar_curve_exponent', 0.6));
  const est = peers.map(p => ({ ageH: (Date.now() - Date.parse(p.published_at)) / HOUR, views: p.view_count })).filter(p => p.ageH >= 14 * 24 && p.ageH <= 180 * 24)
    .map(p => p.views * Math.min(1, (h / p.ageH)) ** exp);
  if (est.length >= 3) return { expected: median(est), source: `estimate from ${est.length} uploads' current views on a front-loaded curve (no launch history yet — accuracy improves as hourly ticks accumulate)`, peers: est.length, confidence: 'low' };
  return { expected: null, source: 'not enough earlier uploads to form a baseline', peers: 0, confidence: 'none' };
}

export function classify(index, ageHours, confidence) {
  if (index === null) return 'no-baseline';
  const bx = Number(getSetting('radar_breakout_x', 2)) * (confidence === 'low' ? 1.5 : 1);
  if (ageHours < 2) return 'warming-up';
  if (index >= bx) return 'breakout';
  if (index >= 1.3) return 'rising';
  if (index >= 0.7) return 'on-track';
  if (ageHours >= 24 && index < 0.4) return 'stalled';
  if (ageHours >= 6) return 'lagging';
  return 'on-track';
}

async function retentionFor(channelId, videoId, publishedAt) {
  const end = dateRange(1).endDate;
  const start = String(publishedAt).slice(0, 10);
  if (start > end) return null;
  const [v, c] = await Promise.all([
    analyticsQuery(channelId, { startDate: start, endDate: end, metrics: 'views,averageViewPercentage', filters: `video==${videoId}`, ttl: 12 * 3600 }),
    analyticsQuery(channelId, { ...dateRange(90), metrics: 'views,averageViewPercentage', ttl: 24 * 3600 }),
  ]);
  const vp = v.rows[0]?.averageViewPercentage, cp = c.rows[0]?.averageViewPercentage;
  if (!Number.isFinite(vp)) return null;
  return { pct: vp, vsChannel: Number.isFinite(cp) && cp ? vp / cp : null };
}

function linkScores(channelId, video) {
  const cands = db.prepare(`SELECT id, title FROM radar_scores WHERE channel_id = ? AND video_id IS NULL AND created_at >= datetime(?, '-45 days')`).all(channelId, video.published_at.replace('T', ' ').slice(0, 19));
  const vt = tokens(video.title), vn = normTitle(video.title);
  let best = null;
  for (const c of cands) {
    const s = normTitle(c.title) === vn ? 1 : jaccard(vt, tokens(c.title));
    if (s >= 0.75 && (!best || s > best.s)) best = { id: c.id, s };
  }
  if (best) db.prepare('UPDATE radar_scores SET video_id = ? WHERE id = ?').run(video.id, best.id);
  return best;
}

let watching = null;
export function watchTick(opts = {}) {
  if (watching) return watching;
  watching = watchTickInner(opts).finally(() => { watching = null; });
  return watching;
}
async function watchTickInner({ log = () => {} } = {}) {
  const ownDays = Number(getSetting('radar_watch_days', 7));
  const compDays = Number(getSetting('radar_watch_competitor_days', 3));
  const withComps = getSetting('radar_watch_competitors', '1') === '1';
  const owned = listChannels('owned');
  const targets = owned.map(c => ({ ch: c, kind: 'owned', owner: c.id, days: ownDays }));
  if (withComps) {
    const seen = new Set();
    for (const o of owned) for (const l of db.prepare('SELECT c.* FROM competitor_links l JOIN channels c ON c.id = l.competitor_channel_id WHERE l.owned_channel_id = ?').all(o.id)) {
      if (seen.has(l.id) || owned.some(x => x.id === l.id)) continue;
      seen.add(l.id); targets.push({ ch: l, kind: 'competitor', owner: o.id, days: compDays });
    }
  }
  const summary = { channels: 0, watched: 0, ticks: 0, alerts: [], errors: [], at: new Date().toISOString() };
  const want = new Map();
  const autopilotQueue = [];
  for (const t of targets) {
    if (!t.ch.uploads_playlist) continue;
    try {
      const page = await ytGet('playlistItems.list', { part: 'contentDetails', playlistId: t.ch.uploads_playlist, maxResults: 10 }, { ttl: 0, noCache: true });
      for (const it of page.items || []) {
        const pub = it.contentDetails?.videoPublishedAt;
        if (pub && Date.now() - Date.parse(pub) > t.days * DAY) continue;
        want.set(it.contentDetails.videoId, t);
      }
      summary.channels++;
    } catch (e) { summary.errors.push(`${t.ch.title}: ${e.message}`); }
  }
  // Keep ticking videos that are still inside their window even if they dropped off page 1.
  for (const w of db.prepare('SELECT * FROM radar_watch WHERE active = 1').all()) {
    if (want.has(w.video_id)) continue;
    const t = targets.find(x => x.ch.id === w.channel_id);
    if (t) want.set(w.video_id, t);
  }
  if (!want.size) { db.prepare("INSERT INTO settings(key, value) VALUES ('radar_last_watch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(summary)); return summary; }
  let vids = [];
  try { vids = await fetchVideosByIds([...want.keys()], { fresh: true }); } catch (e) { summary.errors.push('videos.list: ' + e.message); }
  const now = Date.now();
  const upsert = db.prepare(`INSERT INTO radar_watch (video_id, channel_id, kind, owner_channel_id, title, thumbnail, published_at, is_short) VALUES (@video_id, @channel_id, @kind, @owner, @title, @thumbnail, @published_at, @is_short)
    ON CONFLICT(video_id) DO UPDATE SET title = excluded.title, thumbnail = excluded.thumbnail, is_short = excluded.is_short`);
  for (const v of vids) {
    const t = want.get(v.id);
    if (!t || v.is_live || v.channel_id !== t.ch.id) continue; // only accept the video for the channel it was listed under
    const ageH = (now - Date.parse(v.published_at)) / HOUR;
    if (ageH < 0) continue;
    const inWindow = ageH <= t.days * 24;
    const existing = db.prepare('SELECT * FROM radar_watch WHERE video_id = ?').get(v.id);
    if (!inWindow && !existing) continue;
    upsert.run({ video_id: v.id, channel_id: v.channel_id, kind: t.kind, owner: t.owner, title: v.title, thumbnail: v.thumbnail, published_at: v.published_at, is_short: v.is_short ? 1 : 0 });
    db.prepare('INSERT INTO radar_ticks (video_id, ts, age_hours, views, likes, comments) VALUES (?, ?, ?, ?, ?, ?)').run(v.id, new Date(now).toISOString(), ageH, v.view_count, v.like_count, v.comment_count);
    summary.ticks++;
    const base = expectedAt(v.channel_id, v.is_short, ageH, v.id);
    const index = base.expected ? v.view_count / Math.max(1, base.expected) : null;
    const status = classify(index, ageH, base.confidence);
    const w = db.prepare('SELECT * FROM radar_watch WHERE video_id = ?').get(v.id);
    let ret = null;
    const ch = t.kind === 'owned' ? getChannel(v.channel_id) : null;
    if (ch?.authorized && ageH >= 48) { try { ret = await retentionFor(v.channel_id, v.id, v.published_at); } catch { ret = null; } }
    db.prepare(`UPDATE radar_watch SET last_tick = ?, age_hours = ?, views = ?, likes = ?, comments = ?, expected = ?, idx = ?, peak_idx = MAX(COALESCE(peak_idx, 0), COALESCE(?, 0)), status = ?, baseline_source = ?, confidence = ?,
      retention_pct = COALESCE(?, retention_pct), retention_vs_channel = COALESCE(?, retention_vs_channel), active = ? WHERE video_id = ?`)
      .run(new Date(now).toISOString(), ageH, v.view_count, v.like_count, v.comment_count, base.expected, index, index, status, base.source, base.confidence, ret?.pct ?? null, ret?.vsChannel ?? null, inWindow ? 1 : 0, v.id);
    summary.watched++;
    const hrs = Math.round(ageH), x = index === null ? null : index.toFixed(1);
    if (status === 'breakout' && !w.alerted_breakout) {
      const title = t.kind === 'owned'
        ? `Radar breakout: "${v.title}" is at ${x}× your usual pace after ${hrs}h. Double down now: pin a comment, cut 2–3 Shorts from it, and script a follow-up while it is hot.`
        : `Radar: ${t.ch.title}'s "${v.title}" is at ${x}× their usual pace after ${hrs}h. A response or better-angle video could ride this demand.`;
      summary.alerts.push(addAlert(t.owner, t.kind === 'owned' ? 'radar_breakout' : 'radar_competitor_breakout', title, { videoId: v.id, channelId: v.channel_id, x: index, ageHours: ageH }));
      db.prepare('UPDATE radar_watch SET alerted_breakout = 1 WHERE video_id = ?').run(v.id);
    }
    if (t.kind === 'owned' && ageH >= 24 && index !== null && index < 0.6 && base.confidence !== 'low' && !w.alerted_lagging) {
      summary.alerts.push(addAlert(t.owner, 'radar_lagging', `Radar: "${v.title}" is at ${x}× your usual pace after ${hrs}h. Test a new title or thumbnail now (Packaging → Thumbnail / Staged edits); packaging is the fastest lever in the first days.`, { videoId: v.id, channelId: v.channel_id, x: index, ageHours: ageH }));
      db.prepare('UPDATE radar_watch SET alerted_lagging = 1 WHERE video_id = ?').run(v.id);
    }
    if (t.kind === 'owned' && !existing) linkScores(v.channel_id, v);
    if (t.kind === 'owned') {
      // Real CTR/impressions from the Reporting API (arrives ~2 days after each day), vs the channel's usual first days.
      const r = reach.videoReach(v.id);
      if (r) {
        const b = reach.channelBaseline(v.channel_id, { days: Math.max(1, Math.min(3, r.days)), excludeId: v.id, isShort: !!v.is_short });
        db.prepare('UPDATE radar_watch SET ctr = ?, impressions = ?, ctr_vs_channel = ? WHERE video_id = ?').run(r.ctr, r.impressions, b && r.ctr !== null ? r.ctr / b.ctr : null, v.id);
      }
      autopilotQueue.push({ video: v, status, ageHours: ageH, confidence: base.confidence, paceIndex: index });
    }
  }
  // Videos past their window stop ticking but keep their final reading (and their launch curve for future baselines).
  for (const w of db.prepare('SELECT video_id, published_at, kind FROM radar_watch WHERE active = 1').all()) {
    const days = w.kind === 'owned' ? ownDays : compDays;
    if (now - Date.parse(w.published_at) > days * DAY) db.prepare('UPDATE radar_watch SET active = 0 WHERE video_id = ?').run(w.video_id);
  }
  // Autopilot: act on lagging owned uploads, then grade earlier changes on real CTR.
  summary.autopilot = [];
  if (autopilotQueue.length || db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'autopilot_actions'").get()) {
    try {
      const ap = await import('./autopilot.js');
      for (const q of autopilotQueue) {
        const dbVideo = db.prepare('SELECT * FROM videos WHERE id = ?').get(q.video.id) || { ...q.video, is_short: q.video.is_short ? 1 : 0 };
        const d = ap.shouldRun(dbVideo, q);
        db.prepare('UPDATE radar_watch SET autopilot_note = ? WHERE video_id = ?').run(d.run ? 'running' : d.why + (d.diagnosis?.kind && d.diagnosis.kind !== 'unknown' ? ` · ${d.diagnosis.kind}` : ''), q.video.id);
        if (!d.run) continue;
        try {
          const a = await ap.runForVideo(q.video.id, { trigger: d.trigger, paceIndex: q.paceIndex, diagnosis: d.diagnosis });
          db.prepare('UPDATE radar_watch SET autopilot_note = ? WHERE video_id = ?').run(`${a.status}: ${a.message}`.slice(0, 300), q.video.id);
          summary.autopilot.push({ videoId: q.video.id, status: a.status });
        } catch (e) { summary.errors.push(`autopilot ${q.video.id}: ${e.message}`); }
      }
      const graded = await ap.evaluatePending();
      if (graded.length) summary.autopilotGraded = graded.length;
    } catch (e) { summary.errors.push('autopilot: ' + e.message); }
  }
  try { await flushHeld(); } catch { /* phone delivery is best-effort */ }
  db.prepare("INSERT INTO settings(key, value) VALUES ('radar_last_watch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ ...summary, alerts: summary.alerts.length }));
  log('[radar] watch', { watched: summary.watched, alerts: summary.alerts.length, autopilot: summary.autopilot.length, errors: summary.errors.length });
  return summary;
}

/** Watch board for an owned workspace: its own uploads + its competitors'. */
export function watchBoard(ownedId, { includeInactive = true, limit = 60 } = {}) {
  const rows = db.prepare(`SELECT w.*, c.title AS channel_title FROM radar_watch w LEFT JOIN channels c ON c.id = w.channel_id
    WHERE (w.channel_id = ? OR w.owner_channel_id = ?) ${includeInactive ? '' : 'AND w.active = 1'} ORDER BY w.published_at DESC LIMIT ?`).all(ownedId, ownedId, limit);
  const last = getSetting('radar_last_watch');
  return {
    lastRun: last ? JSON.parse(last) : null,
    videos: rows.map(r => ({ ...r, is_short: !!r.is_short, active: !!r.active, spark: db.prepare('SELECT age_hours AS h, views AS v FROM radar_ticks WHERE video_id = ? ORDER BY age_hours').all(r.video_id) })),
  };
}

/** Actual launch curve vs expected curve for one watched video (for the chart). */
export function watchCurve(videoId) {
  const w = db.prepare('SELECT * FROM radar_watch WHERE video_id = ?').get(videoId);
  if (!w) return null;
  const ticks = db.prepare('SELECT ts, age_hours, views, likes, comments FROM radar_ticks WHERE video_id = ? ORDER BY age_hours').all(videoId);
  const maxH = Math.max(1, ...ticks.map(t => t.age_hours));
  const steps = 24;
  const expected = [];
  for (let i = 1; i <= steps; i++) { const h = (maxH * i) / steps; const e = expectedAt(w.channel_id, !!w.is_short, h, videoId); expected.push({ h: round(h, 1), v: e.expected === null ? null : Math.round(e.expected) }); }
  return { video: { ...w, is_short: !!w.is_short, active: !!w.active }, ticks, expected };
}

/** Scored ideas and, once linked to an upload, how they actually did. */
export function history(channelId, { limit = 100 } = {}) {
  const rows = db.prepare('SELECT * FROM radar_scores WHERE channel_id = ? ORDER BY id DESC LIMIT ?').all(channelId, limit);
  const linked = rows.filter(r => r.video_id);
  const corpus = linked.length ? buildCorpus(channelId) : [];
  const byId = Object.fromEntries(corpus.map(r => [r.id, r]));
  const watchStmt = db.prepare('SELECT idx, peak_idx, status, age_hours FROM radar_watch WHERE video_id = ?');
  const out = rows.map(r => {
    const c = r.video_id ? byId[r.video_id] : null;
    const w = r.video_id ? watchStmt.get(r.video_id) : null;
    return { id: r.id, batchId: r.batch_id, createdAt: r.created_at, title: r.title, thumbnail: r.thumbnail, keyword: r.keyword, format: r.format, axes: JSON.parse(r.axes_json),
      score: r.composite, coverage: r.coverage, predictedX: r.predicted_x, pBreakout: r.p_breakout, band: r.band, rank: r.rank, modelId: r.model_id,
      videoId: r.video_id, actualX: c?.y !== null && c?.y !== undefined ? round(2 ** c.y) : null, live: w ? { index: round(w.idx), peak: round(w.peak_idx), status: w.status, ageHours: round(w.age_hours, 1) } : null };
  });
  const done = out.filter(r => r.actualX !== null && r.score !== null);
  return { scores: out, tracked: { linked: linked.length, withOutcome: done.length, spearman: done.length >= 5 ? round(spearman(done.map(d => d.score), done.map(d => Math.log2(d.actualX))), 3) : null } };
}

export function linkScore(scoreId, videoId) {
  return db.prepare('UPDATE radar_scores SET video_id = ? WHERE id = ?').run(videoId || null, scoreId).changes;
}

// ---------- calibration jobs (in-memory; results persist in radar_models) ----------
const jobs = new Map();
export function startCalibration(channelId, opts = {}) {
  for (const j of jobs.values()) if (j.channelId === channelId && j.status === 'running') return j;
  const id = 'cal_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = { id, channelId, status: 'running', startedAt: new Date().toISOString(), progress: { stage: 'starting' }, result: null, error: null };
  jobs.set(id, job);
  job.promise = calibrate(channelId, { ...opts, onProgress: p => { job.progress = p; } })
    .then(r => { job.status = 'done'; job.result = r; job.finishedAt = new Date().toISOString(); })
    .catch(e => { job.status = 'failed'; job.error = e.message; job.finishedAt = new Date().toISOString(); });
  return job;
}
export function getJob(id) { const j = jobs.get(id); if (!j) return null; const { promise, ...rest } = j; return rest; }
export async function waitJob(id, timeoutMs = 1800_000) {
  const j = jobs.get(id); if (!j) return null;
  await Promise.race([j.promise, new Promise(r => setTimeout(r, timeoutMs))]);
  return getJob(id);
}

export function axesInfo() {
  return { axes: AXES, defaultWeights: defaultWeights(), defaultMap: DEFAULT_MAP,
    method: 'Composite = weighted mean of the available axes (weights renormalised over axes that could be scored). Predicted multiplier = 2^(α + β·(score−50)/50) relative to your local baseline (median of your 10 nearest-in-time same-format uploads), with an 80% range from the residual spread of the calibration fit. P(breakout) = probability of ≥ 2× under that spread.' };
}
