// AI coach: builds a factual channel context from local data, then asks the model. Nothing is invented.
import { db } from '../db.js';
import { ytGet } from '../youtube/client.js';
import { getAccessToken } from '../youtube/oauth.js';
import { getChannel, hydrateVideo } from './channels.js';
import { performanceSegments, publishSlots } from './analytics.js';
import { channelHealth } from './packaging.js';
import { titlePatterns, formatLabel } from './discovery.js';
import { median } from './stats.js';
import * as ai from './ai.js';

export function channelContext(channelId, { videos = 40 } = {}) {
  const ch = getChannel(channelId);
  if (!ch) return 'No channel selected.';
  const recent = db.prepare('SELECT * FROM videos WHERE channel_id = ? ORDER BY published_at DESC LIMIT ?').all(channelId, videos).map(hydrateVideo);
  const seg = performanceSegments(channelId);
  const health = channelHealth(channelId);
  const slots = publishSlots(channelId);
  const competitors = db.prepare('SELECT c.title, c.subscriber_count, c.video_count FROM competitor_links l JOIN channels c ON c.id = l.competitor_channel_id WHERE l.owned_channel_id = ?').all(channelId);
  const studio = db.prepare('SELECT AVG(ctr) AS ctr, AVG(avg_view_pct) AS avp, COUNT(*) AS n FROM studio_imports WHERE channel_id = ?').get(channelId);
  const lines = [];
  lines.push(`CHANNEL: ${ch.title} (${ch.handle || ch.id}) — ${ch.subscriber_count} subscribers, ${ch.view_count} total views, ${ch.video_count} videos, created ${ch.published_at?.slice(0, 10)}, country ${ch.country || 'n/a'}.`);
  lines.push(`DESCRIPTION: ${(ch.description || '').slice(0, 400)}`);
  lines.push(`LIBRARY: ${recent.length} most recent uploads listed. Long-form median views ${seg.long.median}, Shorts median ${seg.shorts.median}. Breakouts (≥3× median): ${seg.long.breakout.slice(0, 5).map(v => `"${v.title}" (${v.view_count})`).join('; ') || 'none'}. Underperformers: ${seg.long.under.slice(0, 5).map(v => `"${v.title}" (${v.view_count})`).join('; ') || 'none'}.`);
  lines.push(`RECENT UPLOADS (title | views | days ago | format):`);
  for (const v of recent.slice(0, 25)) lines.push(`- ${v.title} | ${v.view_count} | ${Math.round((Date.now() - new Date(v.published_at)) / 86400000)} | ${v.is_short ? 'short' : 'long'} | ${formatLabel(v.title)}`);
  const tp = titlePatterns(recent.map(v => v.title));
  lines.push(`TITLE PATTERNS USED: ${tp.patterns.filter(p => p.count).slice(0, 6).map(p => `${p.pattern} ${Math.round(p.share * 100)}%`).join(', ')}; median length ${tp.medianLength} chars.`);
  lines.push(`METADATA HEALTH: ${health.withIssues}/${health.total} videos with issues: ${Object.entries(health.summary).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}.`);
  if (slots.sampleSize >= 8) lines.push(`BEST PUBLISH WEEKDAYS (own data index): ${slots.byWeekday.filter(d => d.n >= 2).sort((a, b) => (b.index || 0) - (a.index || 0)).slice(0, 3).map(d => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.dow]} ${d.index?.toFixed(2)}× (n=${d.n})`).join(', ')}.`);
  if (studio.n) lines.push(`STUDIO IMPORT: avg CTR ${(studio.ctr || 0).toFixed(2)}%, avg view % ${(studio.avp || 0).toFixed(1)} across ${studio.n} rows.`);
  if (competitors.length) lines.push(`COMPETITORS TRACKED: ${competitors.map(c => `${c.title} (${c.subscriber_count} subs, ${c.video_count} videos)`).join('; ')}.`);
  const cadence = recent.length > 2 ? median(recent.slice(0, -1).map((v, i) => (new Date(v.published_at) - new Date(recent[i + 1].published_at)) / 86400000)) : null;
  if (cadence) lines.push(`UPLOAD CADENCE: median ${cadence.toFixed(1)} days between uploads.`);
  return lines.join('\n');
}

export async function coach(channelId, question, { mode = 'quick', extra = '' } = {}) {
  const ctx = channelContext(channelId, { videos: mode === 'quick' ? 20 : 60 });
  const depth = mode === 'quick' ? 'Answer in under 150 words with one clear recommendation.'
    : mode === 'deep' ? 'Give a structured, sourced answer: cite which numbers from the context support each point. 300-500 words. End with 3 next actions.'
    : 'Max mode: run a full diagnosis across ideas, packaging, hook, retention proxies, cadence, and competitors. Rank issues by expected impact. 600-900 words with a 7-day action list.';
  const prompt = `${ctx}\n\n${extra ? 'ADDITIONAL DATA:\n' + extra + '\n\n' : ''}QUESTION: ${question}\n\n${depth}`;
  return { answer: await ai.ask(`coach_${mode}`, prompt), contextChars: ctx.length };
}

export async function dailyIdeas(channelId, { count = 5, constraints = '' } = {}) {
  const ctx = channelContext(channelId);
  const prompt = `${ctx}\n\nPropose ${count} fresh, original video ideas for this channel today. Each must build on a proven pattern in the channel's own data (name the evidence) and avoid repeating existing titles. Constraints: ${constraints || 'none'}.\nReturn JSON {"ideas":[{"title":"","angle":"","evidence":"","format":"long|short","hook":"first line of the video","thumbnailConcept":""}]}`;
  return await ai.ask('daily_ideas', prompt, { json: true });
}

export async function ideaGenerator({ niche, audience, constraints = '', channelId = null, count = 8 }) {
  const ctx = channelId ? channelContext(channelId, { videos: 20 }) : '';
  const prompt = `${ctx}\n\nNiche: ${niche}\nAudience: ${audience}\nConstraints: ${constraints || 'none'}\nGenerate ${count} video pitches. Each: title, one-line premise, why this audience clicks, format, difficulty (1-5), and what proof/footage is needed.\nReturn JSON {"ideas":[{"title":"","premise":"","why":"","format":"","difficulty":1,"proofNeeded":""}]}`;
  return await ai.ask('idea_generator', prompt, { json: true });
}

export async function audit(channelId) {
  const ctx = channelContext(channelId, { videos: 60 });
  const prompt = `${ctx}\n\nWrite a channel audit. Sections: 1) What is working (with evidence), 2) The single biggest lever, 3) Packaging issues, 4) Content mix and cadence, 5) Ranked priorities (top 5, each with expected impact and effort). Plain language, no fluff, cite numbers from the context. 400-700 words.`;
  const text = await ai.ask('channel_audit', prompt);
  db.prepare('INSERT INTO saved_items (channel_id, kind, title, body) VALUES (?, ?, ?, ?)').run(channelId, 'audit', `Audit ${new Date().toISOString().slice(0, 10)}`, text);
  return { audit: text };
}

export async function weeklyPlan(channelId, { goals = '' } = {}) {
  const ctx = channelContext(channelId, { videos: 30 });
  const prompt = `${ctx}\n\nGoals this week: ${goals || 'grow views'}.\nProduce a 7-day action plan: research tasks, packaging tasks, production, publishing, community. Each day 2-4 concrete tasks with time estimates. Return JSON {"week":[{"day":"Mon","tasks":[{"task":"","minutes":30,"why":""}]}],"focus":"one sentence"}`;
  const plan = await ai.ask('weekly_plan', prompt, { json: true });
  db.prepare('INSERT INTO saved_items (channel_id, kind, title, body) VALUES (?, ?, ?, ?)').run(channelId, 'plan', `Weekly plan ${new Date().toISOString().slice(0, 10)}`, JSON.stringify(plan));
  return plan;
}

export async function validateIdea({ title, premise, evidence = '' }) {
  const prompt = `Validate this video idea before production.
Title: ${title}\nPremise: ${premise}\nEvidence gathered (search results, comments, outliers): ${evidence || 'none — say what evidence is needed'}
Judge: demand (are people asking/searching?), competition gap, fit, and risk. Give a go / refine / no-go verdict with reasons. Return JSON {"verdict":"go|refine|no-go","demand":"","gap":"","risks":[],"whatWouldChangeTheVerdict":[],"requiredEvidence":[]}`;
  return await ai.ask('idea_validation', prompt, { json: true });
}

export async function beginnerNextSteps(channelId) {
  const ctx = channelContext(channelId, { videos: 30 });
  const prompt = `${ctx}\n\nTranslate these numbers into 5 concrete next steps a beginner creator can do this week, each explained in plain words (why it matters, how to do it, how to know it worked). Return JSON {"steps":[{"step":"","why":"","how":"","successSignal":""}]}`;
  return await ai.ask('beginner_steps', prompt, { json: true });
}

export const LESSONS = [
  { id: 'ideas', title: 'Ideas that already have demand', items: ['Mine your own breakouts: what did the ≥3× videos have in common?', 'Read 50 comments on your top video and list every question', 'Check autocomplete for your seed terms; questions reveal intent', 'Validate with outliers: small channels overperforming on the topic'] },
  { id: 'packaging', title: 'Packaging: title + thumbnail as one unit', items: ['Thumbnail shows the subject; title adds the stakes', 'Under 60 characters, one all-caps word max', 'Front-load the keyword, end with the curiosity gap', 'Test on your phone at 160px wide'] },
  { id: 'hook', title: 'The first 30 seconds', items: ['Restate the title promise in 10 seconds', 'Show proof early (result, footage, number)', 'Cut greetings and channel intros', 'Open a loop the video pays off'] },
  { id: 'retention', title: 'Retention', items: ['Find the 3 biggest drops in the retention curve', 'Each drop is a pacing or expectation problem — fix the script, not the edit', 'Pattern-interrupt every 20-40 seconds', 'End with a specific next video, not a generic CTA'] },
  { id: 'cadence', title: 'Cadence and consistency', items: ['Pick a cadence you can keep for 6 months', 'Batch research, script, record, edit', 'Publish-slot data needs 8+ uploads before it means anything', 'Measure 7-day views per upload, not subscribers'] },
  { id: 'policy', title: 'Policy and disclosure', items: ['Label altered/synthetic content at upload', 'Keep licenses for music, footage and images', 'Made-for-kids setting must be accurate', 'Captions and chapters help accessibility and search'] },
];

/** Fetch an owned video's transcript via captions API (OAuth). Costs 50 + 200 units. */
export async function ownedTranscript(channelId, videoId) {
  const list = await ytGet('captions.list', { part: 'snippet', videoId }, { ttl: 24 * 3600, channelId });
  const tracks = list.items || [];
  if (!tracks.length) throw new Error('No caption tracks on this video yet (YouTube auto-captions can take hours).');
  const track = tracks.find(t => t.snippet.trackKind === 'standard') || tracks.find(t => t.snippet.language?.startsWith('en')) || tracks[0];
  const url = new URL(`${process.env.YT_API_BASE || 'https://www.googleapis.com/youtube/v3'}/captions/${track.id}`);
  url.searchParams.set('tfmt', 'srt');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await getAccessToken(channelId)}` } });
  if (!res.ok) throw new Error(`captions.download failed ${res.status}`);
  const srt = await res.text();
  const { logApi } = await import('../youtube/client.js');
  logApi({ api: 'data', endpoint: 'captions.download', units: 200, cached: 0 });
  return { track: track.snippet, srt, text: srtToText(srt), segments: parseSrt(srt) };
}

export function parseSrt(srt) {
  const blocks = srt.split(/\n\s*\n/);
  const segs = [];
  for (const b of blocks) {
    const lines = b.trim().split('\n');
    const m = lines.find(l => /-->/.test(l));
    if (!m) continue;
    const [start] = m.split('-->').map(s => s.trim());
    const text = lines.slice(lines.indexOf(m) + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    const [h, mi, s] = start.replace(',', '.').split(':');
    segs.push({ start: Number(h) * 3600 + Number(mi) * 60 + Number(s), text });
  }
  return segs;
}
export function srtToText(srt) { return parseSrt(srt).map(s => s.text).join(' '); }

export async function chaptersFromTranscript({ segments, title, targetCount = 8 }) {
  const lines = segments.map(s => `[${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, '0')}] ${s.text}`).join('\n').slice(0, 60000);
  const prompt = `Video title: ${title}\nTranscript with timestamps:\n${lines}\n\nPropose ${targetCount} chapters (first at 0:00, each ≥ 10 s apart). Labels ≤ 6 words, descriptive not clickbait. Return JSON {"chapters":[{"time":"m:ss","label":""}]}`;
  return await ai.ask('chapters', prompt, { json: true });
}

export async function clipMoments({ segments, title, count = 6 }) {
  const lines = segments.map(s => `[${s.start.toFixed(0)}s] ${s.text}`).join('\n').slice(0, 60000);
  const prompt = `Video: ${title}\nTranscript:\n${lines}\n\nFind ${count} self-contained moments (15-60 s) that work as vertical clips: a complete thought with a hook in the first line. Return JSON {"clips":[{"start":0,"end":30,"hook":"","why":"","captionLine":""}]}`;
  return await ai.ask('clip_detection', prompt, { json: true });
}

export async function scriptWriter({ title, outline = '', facts = '', length = 'long', tone = '', channelId = null }) {
  const ctx = channelId ? channelContext(channelId, { videos: 10 }) : '';
  const prompt = `${ctx}\n\nWrite a ${length === 'short' ? '45-60 second vertical' : '8-12 minute'} YouTube script.
Title: ${title}\nOutline: ${outline || 'build one first'}\nVerified facts to use (do not invent facts; mark anything that needs a citation with [CITE]): ${facts || 'none provided — keep claims generic and flag with [CITE]'}\nTone: ${tone || 'direct, concrete'}
Structure: cold open restating the promise (≤ 10 s), proof, sections with pattern interrupts, payoff, specific next-video CTA. Mark B-roll suggestions in brackets. Return plain text.`;
  return { script: await ai.ask('script_writer', prompt) };
}

export async function repurpose({ transcriptText, title, target }) {
  const specs = {
    blog: 'an SEO blog outline + draft (H2 sections, 600-900 words, citations as [source] placeholders)',
    linkedin: 'a LinkedIn post (120-200 words, hook first line, line breaks, one takeaway, no hashtags spam)',
    threads: '5 short Threads/X-style posts (each ≤ 240 chars) that stand alone',
    newsletter: 'a newsletter section (subject line, 250-400 words, one CTA)',
  };
  const prompt = `Source video "${title}" transcript:\n"""${String(transcriptText).slice(0, 40000)}"""\n\nRewrite as ${specs[target] || specs.blog}. Use only what the transcript says. Return plain text.`;
  return { text: await ai.ask(`repurpose_${target}`, prompt) };
}

export async function scoreScript({ script, title }) {
  const prompt = `Editorial rubric review of this script for "${title}" (not a virality prediction).
Script:\n"""${String(script).slice(0, 30000)}"""
Score each 0-10 with one sentence: clarity of promise, hook speed, proof density, pacing/pattern interrupts, specificity, payoff, CTA. Then the three highest-impact edits. Return JSON {"scores":{"promise":0,"hook":0,"proof":0,"pacing":0,"specificity":0,"payoff":0,"cta":0},"notes":{},"edits":[]}`;
  return await ai.ask('script_rubric', prompt, { json: true });
}
