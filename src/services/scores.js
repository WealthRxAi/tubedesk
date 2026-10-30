// Headline scores. Every score exposes its components; none claims to predict CTR or views.
import { db } from '../db.js';
import { suggest } from '../youtube/client.js';
import { hydrateVideo } from './channels.js';
import { analyzeTitle, analyzeDescription, channelHealth } from './packaging.js';
import { performanceSegments } from './analytics.js';
import { median, clamp, daysSince } from './stats.js';

const REGIONS = ['US', 'GB', 'CA', 'AU', 'IN'];
const QUESTIONS = ['how', 'what', 'why', 'is', 'can', 'does', 'should', 'when'];

/**
 * Demand Index (0-100) for a keyword from free signals. Components:
 *  presence   — share of regions where YouTube autocompletes the exact seed (people type it everywhere)
 *  depth      — how many distinct completions the seed and its question variants produce (breadth of intent)
 *  questions  — how many question variants autocomplete (intent to learn → watch)
 *  velocity   — (optional, when a search sample is supplied) log views/day of the top results
 * Labelled an index, not a search volume: YouTube publishes no volume figure; any tool showing one is estimating.
 */
export async function demandIndex(seed, { country = 'US', sample = null } = {}) {
  const s = seed.toLowerCase().trim();
  const regionLists = await Promise.all(REGIONS.map(r => suggest(s, { country: r })));
  const presentIn = REGIONS.filter((r, i) => regionLists[i].some(x => x.toLowerCase() === s || x.toLowerCase().startsWith(s + ' ')));
  const home = regionLists[REGIONS.indexOf(country)] || regionLists[0] || [];
  const homePos = home.findIndex(x => x.toLowerCase() === s);
  const qLists = await Promise.all(QUESTIONS.map(q => suggest(`${q} ${s}`, { country })));
  const questionCount = qLists.reduce((a, l) => a + l.filter(x => x.toLowerCase().includes(s)).length, 0);
  const distinct = new Set([...home, ...qLists.flat()].map(x => x.toLowerCase())).size;
  const components = {
    presence: Math.round((presentIn.length / REGIONS.length) * 100),
    depth: Math.round(clamp(distinct / 40, 0, 1) * 100),
    questions: Math.round(clamp(questionCount / 24, 0, 1) * 100),
    exactMatchRank: homePos >= 0 ? Math.round((1 - homePos / 10) * 100) : 0,
  };
  let weights = { presence: 0.3, depth: 0.25, questions: 0.25, exactMatchRank: 0.2 };
  if (sample && sample.length) {
    const vpd = median(sample.map(v => v.view_count / Math.max(1, daysSince(v.published_at))));
    components.velocity = Math.round(clamp(Math.log10(1 + vpd) / 4, 0, 1) * 100); // 10K views/day ≈ 100
    weights = { presence: 0.2, depth: 0.2, questions: 0.2, exactMatchRank: 0.15, velocity: 0.25 };
  }
  const score = Math.round(Object.entries(weights).reduce((a, [k, w]) => a + w * (components[k] || 0), 0));
  const band = score >= 70 ? 'high' : score >= 40 ? 'moderate' : score >= 15 ? 'low' : 'minimal';
  return {
    keyword: seed, country, demandIndex: score, band, components, weights, regionsPresent: presentIn, homeRank: homePos >= 0 ? homePos + 1 : null,
    note: 'Index from free autocomplete signals' + (sample ? ' plus the search-sample view velocity' : '') + '. It is not a monthly search volume — YouTube does not publish one; competitors estimate it from extension telemetry.',
  };
}

/** Video Score: packaging (title + description + metadata completeness) × performance vs channel median. */
export function videoScore(videoId) {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!v) return null;
  const hv = hydrateVideo(v);
  const seg = performanceSegments(v.channel_id);
  const med = (hv.is_short ? seg.shorts.median : seg.long.median) || 0;
  const ta = analyzeTitle(hv.title), da = analyzeDescription(hv.description);
  const meta = [hv.tags.length >= 5, !!hv.default_language, !!hv.category_id, !!hv.thumbnail].filter(Boolean).length / 4;
  const packaging = Math.round(0.45 * ta.score + 0.35 * da.score + 0.2 * meta * 100);
  const ratio = med ? hv.view_count / med : null;
  const performance = ratio === null ? null : Math.round(clamp(50 + 25 * Math.log2(Math.max(0.05, ratio)), 0, 100)); // 1× = 50, 4× = 100, 0.25× = 0
  const age = daysSince(hv.published_at);
  const engagement = hv.view_count ? (hv.like_count + hv.comment_count) / hv.view_count : 0;
  const engagementScore = Math.round(clamp(engagement / 0.06, 0, 1) * 100); // 6% likes+comments/views = 100
  const score = performance === null ? packaging : Math.round(0.4 * packaging + 0.45 * performance + 0.15 * engagementScore);
  return {
    videoId, score, grade: grade(score), components: { packaging, performance, engagement: engagementScore },
    detail: { title: ta.score, description: da.score, metadata: Math.round(meta * 100), viewsVsMedian: ratio, channelMedian: med, engagementRate: engagement, ageDays: Math.round(age) },
    formula: performance === null ? 'packaging only (no channel median yet)' : '0.40×packaging + 0.45×performance (log2 of views ÷ channel median, 1×=50, 4×=100) + 0.15×engagement (likes+comments ÷ views, 6%=100)',
  };
}

export function videoScoresForChannel(channelId) {
  const ids = db.prepare('SELECT id FROM videos WHERE channel_id = ?').all(channelId).map(r => r.id);
  const out = {};
  for (const id of ids) { const s = videoScore(id); if (s) out[id] = { score: s.score, grade: s.grade }; }
  return out;
}

/** Channel Score: consistency, packaging health, performance spread, engagement, growth. */
export function channelScore(channelId) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch) return null;
  const vids = db.prepare('SELECT * FROM videos WHERE channel_id = ? AND is_live = 0 ORDER BY published_at DESC').all(channelId).map(hydrateVideo);
  const recent = vids.filter(v => daysSince(v.published_at) <= 90);
  const health = channelHealth(channelId);
  const seg = performanceSegments(channelId);
  const hist = db.prepare(`SELECT day, subs, views FROM snapshots WHERE entity_type='channel' AND entity_id = ? ORDER BY day`).all(channelId);
  // Consistency: uploads/week over 90d, 1/week = 70, 2+/week = 100
  const upw = recent.length / (90 / 7);
  const consistency = Math.round(clamp(upw / 2, 0, 1) * 100);
  // Packaging health: share of videos without issues
  const packaging = health.total ? Math.round(100 * (1 - health.withIssues / health.total)) : 0;
  // Hit rate: share of long-form videos ≥ 1.3× median (reward repeatable wins, not one spike)
  const long = seg.long; const nLong = long.breakout.length + long.above.length + long.typical + long.under.length;
  const hitRate = nLong ? Math.round(100 * clamp(((long.breakout.length + long.above.length) / nLong) / 0.4, 0, 1)) : 0;
  // Engagement
  const eng = vids.slice(0, 50).map(v => v.view_count ? (v.like_count + v.comment_count) / v.view_count : 0);
  const engagement = Math.round(clamp((median(eng) || 0) / 0.05, 0, 1) * 100);
  // Growth: subscriber delta over the snapshot window relative to size (needs ≥ 7 days)
  let growth = null;
  if (hist.length >= 7) {
    const first = hist[0], last = hist[hist.length - 1];
    const days = Math.max(1, (new Date(last.day) - new Date(first.day)) / 86400000);
    const monthly = ((last.subs - first.subs) / Math.max(100, first.subs)) * (30 / days);
    growth = Math.round(clamp(monthly / 0.1, 0, 1) * 100); // +10%/month = 100
  }
  const comps = { consistency, packaging, hitRate, engagement, ...(growth !== null ? { growth } : {}) };
  const weights = growth !== null ? { consistency: 0.2, packaging: 0.2, hitRate: 0.25, engagement: 0.15, growth: 0.2 } : { consistency: 0.25, packaging: 0.25, hitRate: 0.3, engagement: 0.2 };
  const score = Math.round(Object.entries(weights).reduce((a, [k, w]) => a + w * comps[k], 0));
  const weakest = Object.entries(comps).sort((a, b) => a[1] - b[1])[0];
  const advice = {
    consistency: 'Upload cadence is the weakest signal: pick a schedule you can hold for 90 days.',
    packaging: 'Metadata health is the weakest signal: fix the top-viewed videos flagged under Packaging → Channel health first.',
    hitRate: 'Hit rate is the weakest signal: study your breakouts and make more of what already worked.',
    engagement: 'Engagement is the weakest signal: end videos with a specific question and reply to comments within the first hours.',
    growth: 'Growth is the weakest signal: subscriber conversion is low relative to size — check which videos earn subscribers under Analytics → Subscribers.',
  }[weakest[0]];
  return { channelId, score, grade: grade(score), components: comps, weights, weakest: weakest[0], advice, sample: { videos: vids.length, recent90d: recent.length, snapshotDays: hist.length } };
}

function grade(s) { return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'E'; }
