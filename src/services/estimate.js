// Revenue estimates for videos and channels you do NOT own (public data only).
// Same method vidIQ/Social Blade use: views × an RPM band for the niche. It is a scenario, never a measurement —
// real revenue for your own channels lives in Analytics → Revenue (monetary scope).
import { RPM_BANDS } from './misc.js';

// YouTube categoryId → RPM band niche (fallbacks; keyword hints override).
const CATEGORY_NICHE = {
  '1': 'Entertainment / vlogs', '2': 'Technology / software', '10': 'Entertainment / vlogs', '15': 'Pets & animals', '17': 'Health & fitness',
  '19': 'Travel', '20': 'Gaming', '22': 'Entertainment / vlogs', '23': 'Entertainment / vlogs', '24': 'Entertainment / vlogs', '25': 'Business / marketing',
  '26': 'Personal development', '27': 'Education & science', '28': 'Technology / software', '29': 'Personal development',
};
const HINTS = [
  ['Finance & investing', /\b(tax|taxes|irs|deduction|invest|investing|stock|stocks|etf|401k|ira|roth|crypto|bitcoin|dividend|mortgage|credit score|budget|retire|retirement|wealth|money|income|passive income|cpa|bookkeep|accounting|insurance|loan|debt|inflation|fed\b|economy)\b/i],
  ['Real estate', /\b(real estate|realtor|rental property|landlord|airbnb|house flip|home buying|property)\b/i],
  ['Business / marketing', /\b(marketing|startup|saas|entrepreneur|dropship|ecommerce|shopify|sales funnel|seo|agency|side hustle|business)\b/i],
  ['Technology / software', /\b(ai|chatgpt|claude|gpt|llm|openai|software|coding|programming|python|javascript|developer|app|iphone|android|laptop|gpu|tech)\b/i],
  ['Health & fitness', /\b(workout|fitness|gym|diet|protein|weight loss|yoga|keto|calories|health|doctor|nutrition)\b/i],
  ['Education & science', /\b(science|physics|history|historical|ancient|medieval|victorian|century|empire|pharaoh|egypt|roman|rome|viking|vikings|dynasty|battle|war|ww1|ww2|wwii|time travel(?:led|ed)?|time-travel(?:led|ed)?|time traveller|\d{2,4}\s?(?:bc|ad)|math|space|nasa|biology|chemistry|explained|documentary|lecture|tutorial)\b/i],
  ['Food & cooking', /\b(recipe|cooking|baking|kitchen|chef|meal prep)\b/i],
  ['Travel', /\b(travel|trip|vlog in|visiting|tour of|flight|hotel)\b/i],
  ['Gaming', /\b(minecraft|fortnite|roblox|gameplay|gaming|playthrough|speedrun|ps5|xbox|nintendo)\b/i],
  ['Kids & family', /\b(kids|toddler|nursery rhyme|cartoon for kids|baby|children)\b/i],
  ['Pets & animals', /\b(dog|puppy|cat|kitten|pet|aquarium|horse)\b/i],
];

// Score every niche by how many hint words it matches and take the strongest, instead of the first niche that
// matches at all. First-match let one stray word decide a whole channel (e.g. a history channel with one "app"
// title was filed under Technology). Ties keep HINTS order; no match falls back to the YouTube category.
export function nicheScores(text) {
  const scores = {};
  for (const [niche, re] of HINTS) {
    const n = (text.match(new RegExp(re.source, 'gi')) || []).length;
    if (n) scores[niche] = n;
  }
  return scores;
}
export function nicheFor({ categoryId, title = '', tags = [], description = '', isShort = false }) {
  if (isShort) return 'Shorts (any niche)';
  const text = `${title} ${(tags || []).join(' ')} ${(description || '').slice(0, 300)}`;
  const scores = nicheScores(text);
  let best = null;
  for (const [niche] of HINTS) if (scores[niche] && (!best || scores[niche] > scores[best])) best = niche;
  return best || CATEGORY_NICHE[String(categoryId)] || 'Entertainment / vlogs';
}

export function estVideoRevenue(v) {
  const niche = nicheFor({ categoryId: v.category_id, title: v.title, tags: v.tags, description: v.description, isShort: v.is_short });
  const [lo, hi] = RPM_BANDS[niche];
  const views = Number(v.view_count || 0);
  return { low: round2(views / 1000 * lo), high: round2(views / 1000 * hi), rpmLow: lo, rpmHigh: hi, niche };
}

// Monthly channel estimate from its recent uploads: views accrued in the last 30 days ≈ Σ views-per-day × 30 over recent videos,
// capped by actual views of videos ≤30 days old where known.
export function estChannelMonthly(channel, recentVideos, nicheOverride = null) {
  const now = Date.now();
  let monthlyViews = 0;
  for (const v of recentVideos) {
    const age = Math.max(1, (now - new Date(v.published_at)) / 86400000);
    monthlyViews += age <= 30 ? Number(v.view_count || 0) : Number(v.view_count || 0) / age * 30 * decay(age);
  }
  const longform = recentVideos.filter(v => !v.is_short);
  const sample = longform.length ? longform[0] : recentVideos[0];
  const niche = nicheOverride || (sample ? nicheFor({ categoryId: sample.category_id, title: recentVideos.map(v => v.title).join(' '), tags: [], isShort: false }) : 'Entertainment / vlogs');
  const [lo, hi] = RPM_BANDS[niche];
  const shortsShare = recentVideos.length ? recentVideos.filter(v => v.is_short).reduce((s, v) => s + Number(v.view_count || 0), 0) / Math.max(1, recentVideos.reduce((s, v) => s + Number(v.view_count || 0), 0)) : 0;
  const [slo, shi] = RPM_BANDS['Shorts (any niche)'];
  const effLo = lo * (1 - shortsShare) + slo * shortsShare, effHi = hi * (1 - shortsShare) + shi * shortsShare;
  return {
    monthlyViews: Math.round(monthlyViews), low: round2(monthlyViews / 1000 * effLo), high: round2(monthlyViews / 1000 * effHi),
    yearlyLow: round2(monthlyViews * 12 / 1000 * effLo), yearlyHigh: round2(monthlyViews * 12 / 1000 * effHi),
    niche, shortsShare: Math.round(shortsShare * 100), sample: recentVideos.length,
    note: 'Scenario: recent-upload view velocity × niche RPM band. Not a measurement — YouTube never publishes other channels\' revenue.',
  };
}

// Older videos still earn, but their daily views fall off; discount views/day on videos older than 30 days.
function decay(ageDays) { return ageDays <= 30 ? 1 : Math.max(0.15, 30 / ageDays); }
function round2(x) { return Math.round(x * 100) / 100; }
