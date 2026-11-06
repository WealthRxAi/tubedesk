#!/usr/bin/env node
// Stand-in for the Claude Code CLI in tests: reads the prompt on stdin and answers deterministically.
//  - radar rating prompts ("ITEM key=…") → per-item axes; thumbnails cut by the autopilot (autopilot-*.jpg) rate higher
//  - autopilot title prompts → 4 alternative titles + thumbText
//  - daily idea prompts → ideas citing the first signal ids in the prompt
// Anything else gets an empty JSON object.
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_DUMP) dump(input);
  if (/Write 4 alternative titles/.test(input)) {
    const cur = (/Current title: (.*)/.exec(input) || [])[1] || 'this';
    return out({ titles: [
      { title: `Nobody Warns You About This Medicaid Mistake`, angle: 'stakes' },
      { title: `Why ${cur.split(' ').slice(0, 3).join(' ')} Costs Families $40K`, angle: 'outcome' },
      { title: `Stop: Check This Before You Apply`, angle: 'warning' },
      { title: cur, angle: 'duplicate of current — must be dropped' },
    ], thumbText: 'DON\'T SIGN YET' });
  }
  if (/Propose \d+ video ideas/.test(input)) {
    const ids = [...input.matchAll(/^\[([COSA]\d+)\]/gm)].map(m => m[1]);
    const first = t => ids.find(i => i.startsWith(t));
    const ideas = [
      { topic: 'Medicaid lookback traps', angle: 'Competitor breakout shows demand; nobody explains the gift exceptions.', titles: ['The 5-Year Lookback Mistake That Costs $80K', 'Medicaid Lookback: 3 Gifts That Are Safe', 'Why Nobody Warns You About the Lookback'], keyword: 'medicaid lookback', thumbText: '5 YEARS', hook: 'If your mom gave you money, Medicaid can deny her care. Here is the rule.', format: 'long', sources: [first('C'), first('O')].filter(Boolean) },
      { topic: 'Assisted living tax deduction', angle: 'Search terms show viewers asking this.', titles: ['Is Assisted Living Tax Deductible?', 'The Assisted Living Deduction Families Miss', 'Stop Overpaying Taxes on Mom’s Care'], keyword: 'assisted living tax deduction', thumbText: 'DEDUCT IT', hook: 'Most families pay for care and never claim it.', format: 'long', sources: [first('S'), first('A')].filter(Boolean) },
      { topic: 'POA in 60 seconds', angle: 'Short follow-up to your winner.', titles: ['Power of Attorney in 60 Seconds', 'The POA Form Nobody Explains', 'Sign This Before It’s Too Late'], keyword: 'power of attorney', thumbText: 'SIGN NOW', hook: 'One signature saves months in court.', format: 'short', sources: [first('O') || ids[0]].filter(Boolean) },
    ];
    return out({ ideas });
  }
  const imagePaths = (input.match(/^\d+\. (\/.*)$/gm) || []).map(l => l.replace(/^\d+\. /, ''));
  const single = (/First read the image file at (\S+)/.exec(input) || [])[1];
  if (single) imagePaths.push(single);
  const items = [];
  const re = /ITEM key=(\S+)\nTitle: (.*)\nThumbnail: (.*)\nOpening hook: ([\s\S]*?)(?=\n\nITEM key=|\n\nReturn JSON)/g;
  let m;
  while ((m = re.exec(input))) {
    const [, key, title, thumb, hook] = m;
    let h = 0; for (const c of title) h = (h * 31 + c.charCodeAt(0)) % 997;
    const imgNo = /^image (\d+)/.exec(thumb)?.[1];
    const imgPath = imgNo ? imagePaths[Number(imgNo) - 1] || '' : '';
    items.push({
      key,
      curiosity: 35 + (h % 50) + (/\?|why|nobody|until/i.test(title) ? 10 : 0),
      emotion: /shock|nobody|stop|warn|mistake|cost/i.test(title) ? 82 : 44,
      thumbnail: imgNo ? (/\/autopilot-[^/]*$/.test(imgPath) ? 88 : 61) : null,
      hook: hook.trim() === 'none' ? null : 72,
      why: `rated ${title.slice(0, 20)}`,
      fix: 'Name the specific dollar amount in the title.',
    });
  }
  out(items.length ? { items, _images: imagePaths.length } : {});
});
function out(o) { process.stdout.write(JSON.stringify(o)); }
function dump(t) { import('node:fs').then(fs => fs.writeFileSync(`${process.env.FAKE_CLAUDE_DUMP}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`, t)); }
