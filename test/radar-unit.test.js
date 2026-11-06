// Unit tests for the virality radar's statistics: tokenising, correlation, weight fitting, holdout, prediction, launch curves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TUBEDESK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'td-radar-unit-'));
const R = await import('../src/services/radar.js');

test('tokens drop stopwords/numbers and fold plurals; jaccard', () => {
  const a = R.tokens('7 Medicaid Rules That Quietly Cost Families $100K');
  assert.deepEqual([...a].sort(), ['100k', 'cost', 'familie', 'medicaid', 'quietly', 'rule']);
  assert.equal(R.jaccard(R.tokens('Medicaid rules explained'), R.tokens('Medicaid Rules Explained!')), 1);
  assert.equal(R.jaccard(R.tokens('assisted living costs'), R.tokens('power of attorney')), 0);
  assert.equal(R.jaccard(new Set(), R.tokens('x')), 0);
});

test('spearman, normal cdf', () => {
  assert.equal(R.spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]), 1);
  assert.equal(R.spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1);
  assert.ok(Math.abs(R.spearman([1, 2, 2, 3], [1, 2, 3, 4]) - 0.9487) < 0.01, 'ties use average ranks');
  assert.equal(R.spearman([1, 2], [1, 2]), null);
  assert.ok(Math.abs(R.normCdf(0) - 0.5) < 1e-6 && Math.abs(R.normCdf(1.2816) - 0.9) < 1e-3);
});

test('composite renormalises over the axes that could be scored', () => {
  const w = R.defaultWeights();
  const full = R.composite({ demand: 50, patternFit: 50, freshness: 50, titleCraft: 50, curiosity: 50, emotion: 50, thumbnail: 50, hook: 50 }, w);
  assert.equal(Math.round(full.score), 50); assert.ok(Math.abs(full.coverage - 1) < 1e-9);
  const part = R.composite({ titleCraft: 80, patternFit: 60 }, w);
  assert.ok(Math.abs(part.score - (0.1 * 80 + 0.2 * 60) / 0.3) < 1e-9);
  assert.ok(Math.abs(part.coverage - 0.3) < 1e-9);
  assert.equal(R.composite({}, w).score, null);
});

test('prediction is monotonic, has a range, and a breakout probability', () => {
  const lo = R.predict(20), mid = R.predict(50), hi = R.predict(90);
  assert.ok(lo.multiplier < mid.multiplier && mid.multiplier < hi.multiplier);
  assert.equal(mid.multiplier, 1);
  assert.ok(hi.range80[0] < hi.multiplier && hi.multiplier < hi.range80[1]);
  assert.ok(hi.pBreakout > mid.pBreakout && mid.pBreakout > lo.pBreakout);
  assert.equal(R.predict(null), null);
  assert.equal(R.predict(95, { alpha: 0, beta: 3, sigma: 0.5 }).band, 'Breakout potential');
  assert.equal(R.predict(10, { alpha: 0, beta: 1.5, sigma: 1 }).band, 'Below baseline');
});

// Synthetic history: curiosity drives outcomes, titleCraft is noise-inverse, freshness is pure noise.
function synth(n, seed = 7) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: n }, (_, i) => {
    const curiosity = Math.round(rnd() * 100), titleCraft = Math.round(rnd() * 100), freshness = Math.round(rnd() * 100);
    const y = (curiosity - 50) / 25 - (titleCraft - 50) / 200 + (rnd() - 0.5) * 0.8;
    return { id: 'v' + i, ts: i * 86400000, y, axes: { curiosity, titleCraft, freshness } };
  });
}

test('fitModel learns which axes predict outcomes, keeps live-only axes at prior, fits a positive map', () => {
  const m = R.fitModel(synth(120));
  const prior = R.defaultWeights();
  assert.ok(m.axes.curiosity.rho > 0.8, 'curiosity correlates');
  assert.ok(m.axes.titleCraft.rho < 0.1);
  assert.ok(m.weights.curiosity > prior.curiosity, 'data raises the predictive axis');
  assert.ok(m.weights.titleCraft < prior.titleCraft, 'data lowers the non-predictive axis');
  assert.ok(Math.abs(Object.values(m.weights).reduce((a, b) => a + b, 0) - 1) < 1e-3, 'weights sum to 1');
  assert.equal(m.axes.demand.rho, null); assert.equal(m.axes.hook.rho, null);
  assert.ok(Math.abs(m.weights.demand / m.weights.hook - prior.demand / prior.hook) < 0.05, 'live-only axes keep their prior ratio');
  assert.ok(m.map.fitted && m.map.beta > 0 && m.map.sigma >= 0.35);
  // Fewer rows → closer to the priors (shrinkage).
  const small = R.fitModel(synth(12));
  assert.ok(Math.abs(small.weights.curiosity - prior.curiosity) < Math.abs(m.weights.curiosity - prior.curiosity));
});

test('fitModel with no signal falls back to priors and never inverts the map', () => {
  const rows = synth(60).map(r => ({ ...r, y: -(r.axes.curiosity - 50) / 25, axes: { curiosity: r.axes.curiosity } }));
  const m = R.fitModel(rows);
  assert.ok(m.noSignal);
  assert.equal(m.map.beta, 0); assert.ok(m.map.slopeWasNegative);
});

test('holdout grades on newer videos only', () => {
  const ho = R.holdout(synth(100));
  assert.ok(ho.available && ho.train === 70 && ho.test === 30);
  assert.ok(ho.spearman > 0.6 && ho.verdict === 'useful');
  assert.ok(ho.topQuartileHitRate >= ho.baseHitRate && ho.maeLog2 < ho.maeNaiveLog2);
  assert.equal(R.holdout(synth(12)).available, false);
});

test('launch-curve interpolation and status classification', () => {
  const pts = [{ age: 10, views: 100 }, { age: 20, views: 200 }];
  assert.equal(R.interpAt(pts, 15), 150);
  assert.equal(R.interpAt(pts, 5), 50, '(0,0) is implied');
  assert.equal(R.interpAt(pts, 25), null, 'no extrapolation');
  assert.equal(R.interpAt([{ age: 200, views: 900 }], 10), null, 'first reading too late to trust early ages');
  assert.equal(R.interpAt([{ age: 10, views: 10 }, { age: 100, views: 90 }], 50), null, 'gap too wide');
  assert.equal(R.classify(3, 1, 'high'), 'warming-up');
  assert.equal(R.classify(2.1, 5, 'high'), 'breakout');
  assert.equal(R.classify(2.1, 5, 'low'), 'rising', 'estimated baselines need 1.5× the threshold');
  assert.equal(R.classify(0.5, 8, 'high'), 'lagging');
  assert.equal(R.classify(0.3, 30, 'high'), 'stalled');
  assert.equal(R.classify(1, 30, 'high'), 'on-track');
  assert.equal(R.classify(null, 30, 'none'), 'no-baseline');
});
