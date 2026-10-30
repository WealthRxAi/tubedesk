// Keyword research, outliers, trending, niche exploration — built on search.list, suggest, and local data.
import { db, today, getSetting } from '../db.js';
import { ytGet, suggest, DEFAULT_TTL } from '../youtube/client.js';
import { fetchVideosByIds, fetchChannelsByIds, hydrateVideo } from './channels.js';
import { median, mean, daysSince, clamp } from './stats.js';

const QUESTION_PREFIXES = ['how', 'what', 'why', 'when', 'where', 'which', 'can', 'is', 'does', 'should', 'do', 'will', 'are'];
const MODIFIERS = ['for beginners', 'tutorial', 'explained', 'vs', 'review', 'tips', 'mistakes', 'best', '2026', 'step by step', 'in 10 minutes', 'cheap', 'free', 'without'];

/** Keyword explorer: autocomplete tree (free) → long-tail + question variants. */
export async function keywordExplore(seed, { country = 'US', lang = 'en', deep = true } = {}) {
  const base = await suggest(seed, { country, lang });
  const letters = deep ? 'abcdefghijklmnopqrstuvwxyz'.split('') : [];
  const tasks = [];
  for (const l of letters) tasks.push(suggest(`${seed} ${l}`, { country, lang }));
  for (const q of QUESTION_PREFIXES) tasks.push(suggest(`${q} ${seed}`, { country, lang }));
  const results = await Promise.all(tasks);
  const seen = new Map();
  const add = (list, source) => { for (const s of list) { const k = s.toLowerCase().trim(); if (k && k !== seed.toLowerCase()) seen.set(k, source); } };
  add(base, 'autocomplete');
  results.slice(0, letters.length).forEach(r => add(r, 'alphabet'));
  results.slice(letters.length).forEach(r => add(r, 'question'));
  const all = [...seen.entries()].map(([keyword, source]) => ({ keyword, source, words: keyword.split(/\s+/).length }));
  const questions = all.filter(k => QUESTION_PREFIXES.some(q => k.keyword.startsWith(q + ' ')));
  const longTail = all.filter(k => k.words >= 4 && !questions.includes(k));
  const modifiers = MODIFIERS.map(m => `${seed} ${m}`);
  return { seed, country, total: all.length, autocomplete: base, longTail, questions, modifiers, all, source: 'YouTube autocomplete (public suggest endpoint); no API quota used' };
}

/** Competition evidence for a keyword using a real search.list sample. ~102 quota units, cached 24h. */
export async function keywordCompetition(keyword, { country = 'US', lang = 'en', sample = 25 } = {}) {
  const sr = await ytGet('search.list', { part: 'snippet', q: keyword, type: 'video', regionCode: country, relevanceLanguage: lang, maxResults: sample }, { ttl: DEFAULT_TTL.search });
  const ids = (sr.items || []).map(i => i.id.videoId).filter(Boolean);
  const videos = await fetchVideosByIds(ids);
  const chIds = [...new Set(videos.map(v => v.channel_id))];
  const channels = await fetchChannelsByIds(chIds);
  const chMap = Object.fromEntries(channels.map(c => [c.id, c]));
  const kwWords = keyword.toLowerCase().split(/\s+/);
  const rows = videos.map(v => ({
    ...v,
    channel_subs: chMap[v.channel_id]?.subscriber_count ?? null,
    age_days: Math.round(daysSince(v.published_at)),
    exact_in_title: v.title.toLowerCase().includes(keyword.toLowerCase()),
    partial_in_title: kwWords.every(w => v.title.toLowerCase().includes(w)),
    vpd: v.view_count / Math.max(1, daysSince(v.published_at)),
  }));
  const medViews = median(rows.map(r => r.view_count));
  const medSubs = median(rows.map(r => r.channel_subs).filter(x => x !== null));
  const recentShare = rows.length ? rows.filter(r => r.age_days <= 90).length / rows.length : 0;
  const exactShare = rows.length ? rows.filter(r => r.exact_in_title).length / rows.length : 0;
  const smallChannelShare = rows.length ? rows.filter(r => r.channel_subs !== null && r.channel_subs < 50_000).length / rows.length : 0;
  const totalResults = sr.pageInfo?.totalResults ?? null;
  // Transparent scoring (0-100, higher = easier to rank / more opportunity). Each component is shown to the user.
  const components = {
    smallChannelsRanking: Math.round(smallChannelShare * 100),      // small channels already rank → you can too
    freshContentRanking: Math.round(recentShare * 100),             // search rewards new uploads here
    titleGap: Math.round((1 - exactShare) * 100),                   // few exact-title matches → gap
    demandProxy: Math.round(clamp(Math.log10(Math.max(1, medViews)) / 7, 0, 1) * 100), // median views of ranking videos
  };
  const score = Math.round(0.35 * components.smallChannelsRanking + 0.2 * components.freshContentRanking + 0.15 * components.titleGap + 0.3 * components.demandProxy);
  db.prepare(`INSERT INTO keyword_history (keyword, country, day, suggestion_count, top_video_median_views, avg_channel_subs, recent_upload_share, score)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?) ON CONFLICT(keyword, country, day) DO UPDATE SET top_video_median_views=excluded.top_video_median_views, avg_channel_subs=excluded.avg_channel_subs, recent_upload_share=excluded.recent_upload_share, score=excluded.score`)
    .run(keyword, country, today(), medViews, Math.round(mean(rows.map(r => r.channel_subs).filter(x => x !== null))), recentShare, score);
  return {
    keyword, country, sampleSize: rows.length, totalResultsReported: totalResults,
    medianViews: medViews, medianChannelSubs: medSubs, recentShare, exactTitleShare: exactShare, smallChannelShare,
    opportunityScore: score, components,
    formula: '0.35×small-channels-ranking + 0.20×fresh-content-ranking + 0.15×title-gap + 0.30×demand-proxy (log10 median views of the top results ÷ 7)',
    results: rows.sort((a, b) => b.view_count - a.view_count),
    source: `search.list top ${sample} for "${keyword}" in ${country} + videos.list + channels.list`,
  };
}

/** Rising searches: compare today's autocomplete set with the last stored one for the seed. */
export async function risingSuggestions(seed, { country = 'US' } = {}) {
  const current = (await suggest(seed, { country })).map(s => s.toLowerCase());
  const key = `rising:${country}:${seed.toLowerCase()}`;
  const prev = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const prevList = prev ? JSON.parse(prev.value) : null;
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify({ day: today(), list: current }));
  const newOnes = prevList ? current.filter(c => !prevList.list.includes(c)) : [];
  const gone = prevList ? prevList.list.filter(c => !current.includes(c)) : [];
  return { seed, country, current, comparedTo: prevList?.day || null, newSuggestions: newOnes, droppedSuggestions: gone, note: 'Autocomplete positions reflect current search interest; new entries since your last check are the best "rising" evidence available for free.' };
}

export function keywordHistory(keyword, country = 'US') {
  return db.prepare('SELECT * FROM keyword_history WHERE keyword = ? AND country = ? ORDER BY day').all(keyword, country);
}

/** Outlier score for a list of videos against their own channel baseline (median views of same-format videos). */
export function scoreOutliers(videos, { byChannel = true } = {}) {
  const groups = {};
  for (const v of videos) {
    const k = (byChannel ? v.channel_id : 'all') + ':' + (v.is_short ? 's' : 'l');
    (groups[k] ||= []).push(v);
  }
  const out = [];
  for (const list of Object.values(groups)) {
    const med = median(list.map(v => v.view_count)) || 1;
    const medVpd = median(list.map(v => v.view_count / Math.max(1, daysSince(v.published_at)))) || 1;
    for (const v of list) {
      const vpd = v.view_count / Math.max(1, daysSince(v.published_at));
      out.push({ ...v, baseline_median: med, outlier_x: v.view_count / med, velocity_x: vpd / medVpd, vpd, sample: list.length, subs_ratio: v.channel_subs ? v.view_count / v.channel_subs : null });
    }
  }
  return out.sort((a, b) => b.outlier_x - a.outlier_x);
}

/** Outliers across owned + competitor channels already synced locally (no quota). */
export function localOutliers(channelIds, { format = 'long', minX = 2, days = 365, limit = 100 } = {}) {
  const ph = channelIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT v.*, c.title AS channel_title, c.subscriber_count AS channel_subs FROM videos v JOIN channels c ON c.id = v.channel_id
    WHERE v.channel_id IN (${ph}) AND v.is_live = 0 AND v.published_at >= date('now', ?)`).all(...channelIds, `-${days} days`).map(hydrateVideo);
  const filtered = rows.filter(v => format === 'all' ? true : format === 'shorts' ? v.is_short : !v.is_short);
  return scoreOutliers(filtered).filter(v => v.outlier_x >= minX).slice(0, limit);
}

/** Search-driven outliers: find videos matching a topic published recently and rank by view/subscriber ratio and velocity. */
export async function searchOutliers(query, { country = 'US', publishedWithinDays = 90, maxSubscribers = null, format = 'all', order = 'viewCount', sample = 50 } = {}) {
  const publishedAfter = new Date(Date.now() - publishedWithinDays * 86400000).toISOString();
  const params = { part: 'snippet', q: query, type: 'video', regionCode: country, order, publishedAfter, maxResults: Math.min(50, sample) };
  if (format === 'shorts') params.videoDuration = 'short';
  if (format === 'long') params.videoDuration = 'medium';
  const sr = await ytGet('search.list', params, { ttl: DEFAULT_TTL.search });
  const ids = (sr.items || []).map(i => i.id.videoId).filter(Boolean);
  const videos = await fetchVideosByIds(ids);
  const channels = await fetchChannelsByIds([...new Set(videos.map(v => v.channel_id))]);
  const chMap = Object.fromEntries(channels.map(c => [c.id, c]));
  let rows = videos.map(v => ({ ...v, channel_subs: chMap[v.channel_id]?.subscriber_count || 0, channel_videos: chMap[v.channel_id]?.video_count || 0, channel_thumbnail: chMap[v.channel_id]?.thumbnail }));
  if (format === 'shorts') rows = rows.filter(v => v.is_short);
  if (format === 'long') rows = rows.filter(v => !v.is_short);
  if (maxSubscribers) rows = rows.filter(v => v.channel_subs <= maxSubscribers);
  rows = rows.map(v => {
    const age = Math.max(1, daysSince(v.published_at));
    const subsRatio = v.view_count / Math.max(100, v.channel_subs);
    return { ...v, age_days: Math.round(age), vpd: v.view_count / age, subs_ratio: subsRatio, breakout_score: Math.round(Math.log10(1 + subsRatio) * 40 + Math.log10(1 + v.view_count / age) * 10) };
  });
  return { query, sampleSize: rows.length, results: rows.sort((a, b) => b.breakout_score - a.breakout_score), source: 'search.list sample ranked by views ÷ channel subscribers (breakout) and views per day (velocity)' };
}

export async function trending({ country = 'US', categoryId = '', limit = 50 } = {}) {
  const res = await ytGet('videos.list', { part: 'snippet,statistics,contentDetails', chart: 'mostPopular', regionCode: country, videoCategoryId: categoryId || undefined, maxResults: Math.min(50, limit) }, { ttl: DEFAULT_TTL.trending });
  return (res.items || []).map(v => ({
    id: v.id, title: v.snippet.title, channel_id: v.snippet.channelId, channel_title: v.snippet.channelTitle, published_at: v.snippet.publishedAt,
    thumbnail: v.snippet.thumbnails?.high?.url || v.snippet.thumbnails?.medium?.url, view_count: Number(v.statistics?.viewCount || 0), like_count: Number(v.statistics?.likeCount || 0),
    comment_count: Number(v.statistics?.commentCount || 0), category_id: v.snippet.categoryId, duration: v.contentDetails?.duration,
  }));
}

export async function categories(country = 'US') {
  const res = await ytGet('videoCategories.list', { part: 'snippet', regionCode: country }, { ttl: DEFAULT_TTL.categories });
  return (res.items || []).filter(c => c.snippet.assignable).map(c => ({ id: c.id, title: c.snippet.title }));
}

/** Niche explorer: find channels for a topic and size them. */
export async function nicheChannels(query, { country = 'US', sample = 25 } = {}) {
  const sr = await ytGet('search.list', { part: 'snippet', q: query, type: 'channel', regionCode: country, maxResults: Math.min(50, sample) }, { ttl: DEFAULT_TTL.search });
  const ids = (sr.items || []).map(i => i.id.channelId).filter(Boolean);
  const channels = await fetchChannelsByIds(ids);
  return channels.map(c => ({ ...c, views_per_video: c.video_count ? c.view_count / c.video_count : 0, age_days: Math.round(daysSince(c.published_at)) })).sort((a, b) => b.subscriber_count - a.subscriber_count);
}

/** Similar videos for a given video: search its title words, exclude itself. */
export async function similarVideos(videoId, { country = 'US' } = {}) {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId) || (await fetchVideosByIds([videoId]))[0];
  if (!v) return { results: [] };
  const q = v.title.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 6).join(' ');
  const out = await searchOutliers(q, { country, publishedWithinDays: 3650, sample: 25 });
  return { basedOn: v.title, query: q, results: out.results.filter(r => r.id !== videoId) };
}

/** Title structure patterns across a set of titles (no copying: returns templates, not titles). */
export function titlePatterns(titles) {
  const patterns = {
    'Number list ("7 ...")': /^\d+\s/,
    'How to': /^how (to|i|we)\b/i,
    'Question': /\?\s*$|^(why|what|how|when|is|are|do|does|can|should)\b/i,
    'Versus / comparison': /\bvs\.?\b|\bversus\b|\bor\b.*\?/i,
    'I tried / I tested': /^i (tried|tested|spent|built|made|lived|quit|bought)/i,
    'Negative / warning': /\b(never|stop|don't|mistake|worst|avoid|wrong|lie|scam)\b/i,
    'Superlative': /\b(best|ultimate|only|biggest|most|fastest|easiest|cheapest)\b/i,
    'Time-bound': /\b(\d+\s?(days?|hours?|minutes?|weeks?|years?))\b/i,
    'Parenthetical / bracket': /[\(\[].*[\)\]]/,
    'Colon split': /:/,
    'All-caps emphasis word': /\b[A-Z]{3,}\b/,
    'Secret / hidden / nobody': /\b(secret|hidden|nobody|no one|truth|exposed|revealed)\b/i,
    'Money amount': /\$\s?\d/,
    'Year': /\b20\d\d\b/,
  };
  const counts = Object.fromEntries(Object.keys(patterns).map(k => [k, 0]));
  for (const t of titles) for (const [k, re] of Object.entries(patterns)) if (re.test(t)) counts[k]++;
  const n = titles.length || 1;
  const lengths = titles.map(t => t.length);
  const wordCounts = titles.map(t => t.split(/\s+/).length);
  return {
    sample: titles.length,
    patterns: Object.entries(counts).map(([pattern, c]) => ({ pattern, count: c, share: c / n })).sort((a, b) => b.count - a.count),
    medianLength: median(lengths), medianWords: median(wordCounts),
  };
}

/** Classify a video into a format label from its title (owner can override by saving to a board). */
export function formatLabel(title = '') {
  const t = title.toLowerCase();
  if (/^\d+\s/.test(t) || /\btop \d+/.test(t)) return 'Listicle';
  if (/^how (to|i|we)\b/.test(t)) return 'How-to';
  if (/\bvs\.?\b|\bversus\b/.test(t)) return 'Comparison';
  if (/\?\s*$/.test(t)) return 'Question';
  if (/^i (tried|tested|spent|built|made|lived|quit|bought)/.test(t)) return 'Challenge / first-person';
  if (/\b(review|unboxing)\b/.test(t)) return 'Review';
  if (/\b(story|what happened|the truth|exposed|documentary|rise and fall)\b/.test(t)) return 'Story / documentary';
  if (/\b(explained|explain|why)\b/.test(t)) return 'Explainer';
  if (/\b(tutorial|guide|course|lesson)\b/.test(t)) return 'Tutorial';
  if (/\b(news|update|announced|just)\b/.test(t)) return 'News / update';
  return 'Other';
}
