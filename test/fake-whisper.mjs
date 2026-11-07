#!/usr/bin/env node
// Stand-in for whisper.cpp's whisper-cli in tests: reads the 16 kHz mono WAV ffmpeg produced, and writes a
// word-level SRT (-ml 1) covering its full length, one word every 0.4 s, at <-of>.srt.
import fs from 'node:fs';
const a = process.argv.slice(2);
const arg = f => a[a.indexOf(f) + 1];
const wav = arg('-f'), of = arg('-of'), model = arg('-m');
if (!wav || !of || !fs.existsSync(wav)) { console.error('fake-whisper: missing -f / -of'); process.exit(2); }
if (!model || !fs.existsSync(model)) { console.error('fake-whisper: model not found ' + model); process.exit(3); }
if (!a.includes('-osrt') || arg('-ml') !== '1') { console.error('fake-whisper: expected -osrt -ml 1'); process.exit(4); }
const seconds = Math.max(0, (fs.statSync(wav).size - 44) / 32000);
const script = 'Medicaid can take the house unless you know this rule. Most families find out too late. The lookback is five years and it counts every gift. Here is the one exception nobody mentions. If your parent pays a caregiver child under a written contract the money is not a gift. That single document saved one family eighty thousand dollars. So before anyone signs anything write the agreement down.'.split(' ');
const ts = t => { const ms = Math.round(t * 1000); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
const out = [];
let n = 1;
for (let t = 0.2, i = 0; t + 0.35 <= seconds; t += 0.4, i++) out.push(`${n++}\n${ts(t)} --> ${ts(t + 0.35)}\n ${script[i % script.length]}\n`);
fs.writeFileSync(of + '.srt', out.join('\n'));
