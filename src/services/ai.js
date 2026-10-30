// AI provider abstraction. Default: Claude Code CLI (`claude -p`) which runs on the local
// Claude subscription with no API bill. Fallback: Anthropic API key. Both support images.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, DATA_DIR } from '../db.js';

export class AIError extends Error { constructor(m) { super(m); this.name = 'AIError'; } }

export function aiProvider() {
  const p = getSetting('ai_provider', 'claude-cli');
  if (p === 'anthropic-api' && getSetting('anthropic_api_key')) return 'anthropic-api';
  if (p === 'none') return 'none';
  return 'claude-cli';
}

function logAI({ feature, provider, promptChars, outputChars, ms, ok, error }) {
  db.prepare('INSERT INTO ai_log(feature, provider, prompt_chars, output_chars, ms, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(feature, provider, promptChars, outputChars || 0, ms, ok ? 1 : 0, error || null);
}

function runClaudeCli(prompt, { imagePath, timeoutMs = 240_000 } = {}) {
  const bin = getSetting('claude_cli_path', 'claude');
  const model = getSetting('claude_cli_model', '');
  const args = ['-p', '--output-format', 'text'];
  if (model) args.push('--model', model);
  // Permit Read so the CLI can open an image we pass by path; nothing else is granted.
  args.push('--allowedTools', 'Read');
  let fullPrompt = prompt;
  if (imagePath) fullPrompt = `First read the image file at ${imagePath} (use the Read tool), then answer.\n\n` + prompt;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: DATA_DIR, env: { ...process.env, CLAUDECODE: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new AIError('Claude CLI timed out')); }, timeoutMs);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(timer); reject(new AIError(`Could not start Claude CLI (${bin}): ${e.message}. Install Claude Code or set the path in Settings.`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) return reject(new AIError(`Claude CLI exited ${code}: ${err.slice(0, 500)}`));
      resolve(out.trim());
    });
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

async function runAnthropicApi(prompt, { imagePath, system } = {}) {
  const key = getSetting('anthropic_api_key');
  const model = getSetting('anthropic_model', 'claude-sonnet-4-5');
  const content = [];
  if (imagePath) {
    const data = fs.readFileSync(imagePath).toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    const mt = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    content.push({ type: 'image', source: { type: 'base64', media_type: mt, data } });
  }
  content.push({ type: 'text', text: prompt });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 4096, system: system || undefined, messages: [{ role: 'user', content }] }),
  });
  const j = await res.json();
  if (!res.ok) throw new AIError(j?.error?.message || `Anthropic API ${res.status}`);
  return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
}

const SYSTEM = `You are TubeDesk's strategy engine for a YouTube creator who owns the channels being analyzed.
Rules: never invent metrics; only use numbers given in the prompt. When uncertain say so. Be concrete and brief.
Never reproduce other creators' titles, thumbnails or scripts verbatim — describe structures and patterns instead.`;

/** ask(feature, prompt, {imagePath, json}) → string, or parsed JSON when json=true */
export async function ask(feature, prompt, { imagePath = null, json = false } = {}) {
  const provider = aiProvider();
  if (provider === 'none') throw new AIError('AI is disabled in Settings. Choose Claude CLI or an Anthropic API key.');
  const full = (json ? prompt + '\n\nRespond with valid JSON only — no prose, no code fences.' : prompt);
  const t0 = Date.now();
  try {
    const text = provider === 'anthropic-api'
      ? await runAnthropicApi(full, { imagePath, system: SYSTEM })
      : await runClaudeCli(SYSTEM + '\n\n' + full, { imagePath });
    logAI({ feature, provider, promptChars: full.length, outputChars: text.length, ms: Date.now() - t0, ok: 1 });
    if (!json) return text;
    return parseJson(text);
  } catch (e) {
    logAI({ feature, provider, promptChars: full.length, ms: Date.now() - t0, ok: 0, error: e.message });
    throw e;
  }
}

export function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = Math.min(...['{', '['].map(c => { const i = cleaned.indexOf(c); return i < 0 ? Infinity : i; }));
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (start !== Infinity && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  throw new AIError('AI returned non-JSON output: ' + text.slice(0, 200));
}

export async function status() {
  const provider = aiProvider();
  if (provider === 'anthropic-api') return { provider, ok: true, detail: 'Anthropic API key set' };
  if (provider === 'none') return { provider, ok: false, detail: 'disabled' };
  const bin = getSetting('claude_cli_path', 'claude');
  return new Promise(resolve => {
    const c = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', d => out += d);
    c.on('error', () => resolve({ provider, ok: false, detail: `claude CLI not found at "${bin}"` }));
    c.on('close', code => resolve({ provider, ok: code === 0, detail: code === 0 ? out.trim() : 'claude CLI returned ' + code }));
  });
}

export function usage(days = 30) {
  return db.prepare(`SELECT substr(ts,1,10) AS day, feature, COUNT(*) AS calls, SUM(ok) AS ok, SUM(ms) AS ms
    FROM ai_log WHERE ts >= datetime('now', ?) GROUP BY day, feature ORDER BY day DESC`).all(`-${days} days`);
}
