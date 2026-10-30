import crypto from 'node:crypto';
import { db } from '../db.js';
import { ytGet, ytWrite, DEFAULT_TTL } from '../youtube/client.js';
import * as ai from './ai.js';

const STOP = new Set('the a an and or of to in on for with is are this that it my your you i we at by from as be was were have has had not but so if just they them he she his her me our us will can do does did very really more most like love great good video videos thanks thank please what when how why who which there here all about out up one get got make made'.split(' '));

function mapThread(t, ownerChannelId) {
  const top = t.snippet.topLevelComment.snippet;
  const replies = (t.replies?.comments || []).map(r => ({ id: r.id, author: r.snippet.authorDisplayName, authorChannelId: r.snippet.authorChannelId?.value, text: r.snippet.textOriginal, likes: r.snippet.likeCount, published_at: r.snippet.publishedAt }));
  const ownerReplied = replies.some(r => r.authorChannelId === ownerChannelId);
  return {
    id: t.id, videoId: t.snippet.videoId, author: top.authorDisplayName, authorChannelId: top.authorChannelId?.value, authorImage: top.authorProfileImageUrl,
    text: top.textOriginal, likes: top.likeCount, published_at: top.publishedAt, totalReplies: t.snippet.totalReplyCount, replies, ownerReplied,
    isQuestion: /\?/.test(top.textOriginal || ''), mentionsOwner: /@/.test(top.textOriginal || ''), isOwner: top.authorChannelId?.value === ownerChannelId,
  };
}

/** Fetch comment threads for a video (public) or across an owned channel. 1 unit per page of 100. */
export async function fetchThreads({ videoId = null, channelId = null, ownerChannelId = null, maxPages = 5, order = 'time', searchTerms = '' }) {
  const out = [];
  let pageToken;
  for (let i = 0; i < maxPages; i++) {
    const params = { part: 'snippet,replies', maxResults: 100, order, pageToken, textFormat: 'plainText', searchTerms: searchTerms || undefined };
    if (videoId) params.videoId = videoId; else params.allThreadsRelatedToChannelId = channelId;
    const res = await ytGet('commentThreads.list', params, { ttl: DEFAULT_TTL.comments });
    for (const t of res.items || []) out.push(mapThread(t, ownerChannelId || channelId));
    pageToken = res.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export function filterThreads(threads, { filter = 'all', q = '' }) {
  let list = threads;
  if (filter === 'unanswered') list = list.filter(t => !t.ownerReplied && !t.isOwner);
  else if (filter === 'questions') list = list.filter(t => t.isQuestion && !t.ownerReplied);
  else if (filter === 'mentions') list = list.filter(t => t.mentionsOwner);
  else if (filter === 'top') list = [...list].sort((a, b) => b.likes - a.likes);
  if (q) list = list.filter(t => t.text.toLowerCase().includes(q.toLowerCase()));
  return list;
}

export function termFrequencies(texts, limit = 80) {
  const freq = {};
  for (const t of texts) for (const w of String(t).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([term, count]) => ({ term, count }));
}

/** Simple question clustering: group questions by their dominant non-stop term. */
export function clusterQuestions(threads) {
  const qs = threads.filter(t => t.isQuestion);
  const tf = Object.fromEntries(termFrequencies(qs.map(q => q.text), 500).map(x => [x.term, x.count]));
  const clusters = {};
  for (const q of qs) {
    const words = q.text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
    const key = words.sort((a, b) => (tf[b] || 0) - (tf[a] || 0))[0] || 'general';
    (clusters[key] ||= { topic: key, count: 0, examples: [], likes: 0 });
    clusters[key].count++; clusters[key].likes += q.likes;
    if (clusters[key].examples.length < 5) clusters[key].examples.push({ id: q.id, text: q.text, author: q.author, likes: q.likes, videoId: q.videoId });
  }
  return Object.values(clusters).sort((a, b) => b.count - a.count || b.likes - a.likes);
}

export async function aiClusterQuestions(threads, channelContext = '') {
  const qs = threads.filter(t => t.isQuestion).slice(0, 150).map(t => `- ${t.text.slice(0, 200)}`).join('\n');
  if (!qs) return { clusters: [] };
  const prompt = `Cluster these audience questions from YouTube comments into 5–10 topics. For each: topic, count, a representative paraphrase, and one video idea that would answer it. Channel: ${channelContext}\n${qs}\nReturn JSON {"clusters":[{"topic":"","count":0,"representative":"","videoIdea":""}]}`;
  return await ai.ask('question_clustering', prompt, { json: true });
}

export async function replyDrafts(thread, { channelContext = '', tone = 'warm, specific, short' } = {}) {
  const prompt = `Draft 3 reply options to this YouTube comment from the creator. Tone: ${tone}. Keep each under 40 words. Do not make factual claims not in the comment or channel context.
Channel: ${channelContext}
Comment by ${thread.author}: """${thread.text}"""
Return JSON {"replies":["...","...","..."]}`;
  return await ai.ask('comment_replies', prompt, { json: true });
}

export async function postReply(channelId, parentId, text) {
  return await ytWrite('comments.insert', { params: { part: 'snippet' }, json: { snippet: { parentId, textOriginal: text } }, channelId });
}

// Templates
export const templates = {
  list: () => db.prepare('SELECT * FROM comment_templates ORDER BY name').all(),
  create: (name, body) => db.prepare('INSERT INTO comment_templates (name, body) VALUES (?, ?)').run(name, body).lastInsertRowid,
  update: (id, name, body) => db.prepare('UPDATE comment_templates SET name = ?, body = ? WHERE id = ?').run(name, body, id).changes,
  remove: (id) => db.prepare('DELETE FROM comment_templates WHERE id = ?').run(id).changes,
  render: (body, vars = {}) => body.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ''),
};

/** Giveaway: deterministic, auditable random pick among unique commenters (optionally those whose comment contains a keyword). */
export function pickWinner(threads, { keyword = '', excludeOwner = true, ownerChannelId = null, count = 1 } = {}) {
  let pool = threads.filter(t => (!keyword || t.text.toLowerCase().includes(keyword.toLowerCase())) && (!excludeOwner || t.authorChannelId !== ownerChannelId));
  const unique = new Map();
  for (const t of pool) if (!unique.has(t.authorChannelId || t.author)) unique.set(t.authorChannelId || t.author, t);
  const entries = [...unique.values()];
  const seed = crypto.randomBytes(8).toString('hex');
  // seeded shuffle so the draw can be re-verified with the published seed
  let h = parseInt(seed.slice(0, 8), 16);
  const rnd = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 2 ** 32; };
  const arr = [...entries];
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return { seed, eligible: entries.length, winners: arr.slice(0, count).map(t => ({ author: t.author, authorChannelId: t.authorChannelId, commentId: t.id, text: t.text })) };
}
