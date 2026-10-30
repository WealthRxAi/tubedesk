import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TUBEDESK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'td-unit-'));

const { parseDuration, isShort } = await import('../src/youtube/client.js');
const { analyzeTitle, analyzeDescription, validateChapters } = await import('../src/services/packaging.js');
const { median, pct } = await import('../src/services/stats.js');
const { parseCsv, importStudioCsv, earningsScenario, toCsv } = await import('../src/services/misc.js');
const { titlePatterns, formatLabel, scoreOutliers } = await import('../src/services/discovery.js');
const { parseSrt } = await import('../src/services/coach.js');
const { parseJson } = await import('../src/services/ai.js');
const { termFrequencies, clusterQuestions, filterThreads, pickWinner } = await import('../src/services/comments.js');

test('ISO 8601 durations', () => {
  assert.equal(parseDuration('PT8M12S'), 492);
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT48S'), 48);
  assert.equal(parseDuration('P1DT2H'), 93600);
  assert.equal(parseDuration(undefined), 0);
});
test('shorts detection', () => {
  assert.equal(isShort(48), true);
  assert.equal(isShort(180), true);
  assert.equal(isShort(181), false);
  assert.equal(isShort(600, 'Title #shorts'), true);
  assert.equal(isShort(0), false);
});
test('stats', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(pct([10, 20, 30, 40], 25), 0.5);
});
test('title analyzer scores and keyword checks', () => {
  const a = analyzeTitle('7 Medicaid Rules That Quietly Cost Families $100K', { keyword: 'medicaid' });
  assert.ok(a.score >= 70, 'good title scores well');
  assert.ok(a.checks.find(c => c.name.includes('Target keyword')).pass);
  const b = analyzeTitle('OMG!!! YOU WON\'T BELIEVE THIS SHOCKING SECRET TRUTH EXPOSED NOW', {});
  assert.ok(b.score < 50, 'clickbait scores poorly');
  assert.ok(analyzeTitle('').score < 40);
});
test('description analyzer and chapters', () => {
  const d = analyzeDescription('Here is the payoff of this video, stated clearly in the first line so it shows above the fold.\n\n0:00 Intro\n1:00 Rule\n2:30 Example\nhttps://a.b #medicaid #parents ' + 'word '.repeat(200));
  assert.ok(d.checks.find(c => c.name.includes('Chapters')).pass);
  assert.equal(d.timestamps, 3);
  const v = validateChapters('0:00 Intro\n0:30 Rule\n1:00 Example');
  assert.equal(v.valid, true);
  const bad = validateChapters('0:10 Intro\n0:15 Rule');
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some(e => /0:00/.test(e)));
  assert.ok(bad.errors.some(e => /at least 3/.test(e)));
});
test('CSV parser handles quotes and CRLF; Studio import maps columns', () => {
  const rows = parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n1,2\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
  const csv = 'Content,Video title,Impressions,Impressions click-through rate (%),Average view duration,Views\nTotal,,1000,4.5,0:03:10,500\nabc12345678,My video,800,5.2,0:04:01,400\n';
  const r = importStudioCsv('UCx', csv, 'test');
  assert.equal(r.imported, 1);
  assert.equal(r.columnsFound.ctr, 'Impressions click-through rate (%)');
});
test('earnings scenario is a range, never a single assertion', () => {
  const e = earningsScenario({ views: 100000, niche: 'Finance & investing' });
  assert.ok(e.adRevenue.low < e.adRevenue.high);
  assert.ok(/not a measurement/.test(e.disclaimer));
});
test('toCsv escapes', () => { assert.equal(toCsv([{ a: 'x,y', b: 1 }]), 'a,b\n"x,y",1'); });
test('title patterns & format labels', () => {
  const p = titlePatterns(['7 Mistakes With Medicaid', 'How to Protect a House', 'Is a Trust Worth It?', 'Medicaid vs Medicare']);
  assert.equal(p.sample, 4);
  assert.ok(p.patterns.find(x => x.pattern.startsWith('Number list')).count === 1);
  assert.equal(formatLabel('7 Mistakes With Medicaid'), 'Listicle');
  assert.equal(formatLabel('How to protect a house'), 'How-to');
  assert.equal(formatLabel('Medicaid vs Medicare'), 'Comparison');
});
test('outlier scoring uses per-channel per-format medians', () => {
  const now = new Date().toISOString();
  const vids = [
    { id: 'a', channel_id: 'c1', is_short: false, view_count: 100, published_at: now }, { id: 'b', channel_id: 'c1', is_short: false, view_count: 100, published_at: now },
    { id: 'c', channel_id: 'c1', is_short: false, view_count: 1000, published_at: now }, { id: 'd', channel_id: 'c1', is_short: true, view_count: 5, published_at: now },
  ];
  const s = scoreOutliers(vids);
  assert.equal(s[0].id, 'c'); assert.equal(s[0].outlier_x, 10); assert.equal(s[0].sample, 3);
  assert.equal(s.find(v => v.id === 'd').outlier_x, 1);
});
test('SRT parsing', () => {
  const segs = parseSrt('1\n00:00:00,000 --> 00:00:04,000\nHello there\n\n2\n00:01:02,500 --> 00:01:05,000\n<i>World</i>\n');
  assert.equal(segs.length, 2); assert.equal(segs[1].start, 62.5); assert.equal(segs[1].text, 'World');
});
test('AI JSON extraction tolerates fences and prose', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure! Here you go: {"titles":[{"title":"x"}]} hope it helps'), { titles: [{ title: 'x' }] });
  assert.throws(() => parseJson('nothing here'));
});
test('comment tools', () => {
  const threads = [
    { id: '1', author: 'A', authorChannelId: 'ca', text: 'Does Medicaid pay for assisted living?', likes: 5, isQuestion: true, ownerReplied: false, isOwner: false, mentionsOwner: false, replies: [] },
    { id: '2', author: 'B', authorChannelId: 'cb', text: 'Great video', likes: 1, isQuestion: false, ownerReplied: true, isOwner: false, mentionsOwner: false, replies: [] },
    { id: '3', author: 'A', authorChannelId: 'ca', text: 'What about medicaid lookback?', likes: 2, isQuestion: true, ownerReplied: false, isOwner: false, mentionsOwner: false, replies: [] },
  ];
  assert.equal(filterThreads(threads, { filter: 'unanswered' }).length, 2);
  assert.equal(filterThreads(threads, { filter: 'questions' }).length, 2);
  const tf = termFrequencies(threads.map(t => t.text));
  assert.equal(tf[0].term, 'medicaid');
  const cl = clusterQuestions(threads);
  assert.equal(cl[0].topic, 'medicaid'); assert.equal(cl[0].count, 2);
  const w = pickWinner(threads, { count: 1 });
  assert.equal(w.eligible, 2, 'unique commenters');
  assert.equal(w.winners.length, 1);
});

test('revenue estimator: niche detection, video range, channel monthly', async () => {
  const est = await import('../src/services/estimate.js');
  assert.equal(est.nicheFor({ title: '1099 tax deductions explained', categoryId: '22' }), 'Finance & investing');
  assert.equal(est.nicheFor({ title: 'anything', isShort: true }), 'Shorts (any niche)');
  assert.equal(est.nicheFor({ title: 'random vlog', categoryId: '20' }), 'Gaming');
  const v = est.estVideoRevenue({ view_count: 100000, title: 'How the IRS audits you', category_id: '27' });
  assert.equal(v.niche, 'Finance & investing'); assert.equal(v.low, 800); assert.equal(v.high, 2500);
  const now = Date.now();
  const vids = [
    { view_count: 30000, published_at: new Date(now - 10 * 86400000).toISOString(), title: 'tax tips', category_id: '27', is_short: false },
    { view_count: 60000, published_at: new Date(now - 60 * 86400000).toISOString(), title: 'tax tips 2', category_id: '27', is_short: false },
  ];
  const m = est.estChannelMonthly({ view_count: 1e6, video_count: 100 }, vids);
  assert.ok(m.monthlyViews > 30000 && m.monthlyViews < 90000, `monthly views ${m.monthlyViews}`);
  assert.ok(m.low > 0 && m.high > m.low && m.yearlyHigh === Math.round(m.monthlyViews * 12 / 1000 * 25 * 100) / 100 && m.shortsShare === 0);
});
