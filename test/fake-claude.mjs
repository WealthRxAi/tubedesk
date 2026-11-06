#!/usr/bin/env node
// Stand-in for the Claude Code CLI in tests: reads the prompt on stdin and answers radar rating prompts
// deterministically (other prompts get an empty JSON object). Logs how many images it was asked to read.
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  const items = [];
  const re = /ITEM key=(\S+)\nTitle: (.*)\nThumbnail: (.*)\nOpening hook: ([\s\S]*?)(?=\n\nITEM key=|\n\nReturn JSON)/g;
  let m;
  while ((m = re.exec(input))) {
    const [, key, title, thumb, hook] = m;
    let h = 0; for (const c of title) h = (h * 31 + c.charCodeAt(0)) % 997;
    items.push({
      key,
      curiosity: 35 + (h % 50) + (/\?|why|nobody|until/i.test(title) ? 10 : 0),
      emotion: /shock|nobody|stop|warn|mistake|cost/i.test(title) ? 82 : 44,
      thumbnail: thumb.startsWith('image') ? 61 : null,
      hook: hook.trim() === 'none' ? null : 72,
      why: `rated ${title.slice(0, 20)}`,
      fix: 'Name the specific dollar amount in the title.',
    });
  }
  const images = (input.match(/^\d+\. \/.*$/gm) || []).length || (/First read the image file at/.test(input) ? 1 : 0);
  process.stdout.write(items.length ? JSON.stringify({ items, _images: images }) : '{}');
});
