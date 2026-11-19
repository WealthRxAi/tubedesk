#!/usr/bin/env node
// TubeDesk MCP server (stdio, no dependencies). Lets any local MCP client — Claude Code, Claude Desktop, Cursor, Codex,
// Gemini CLI, etc. — use TubeDesk by calling the local TubeDesk server. Remote clients (ChatGPT, claude.ai, phones) use
// TubeDesk's own HTTPS endpoint instead: Settings → Use TubeDesk from any AI.
//   claude mcp add tubedesk -- node /path/to/tubedesk/mcp/server.js
//   TUBEDESK_URL=http://localhost:4949 (default)
import readline from 'node:readline';
import { createToolRunner, handleMcpMessage } from './tools.js';

const BASE = (process.env.TUBEDESK_URL || 'http://localhost:4949').replace(/\/$/, '');

async function call(method, path, body) {
  let res;
  try { res = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { // no HTTP response at all: TubeDesk isn't reachable
    const why = e.cause?.code || e.cause?.message || e.message;
    throw new Error(`TubeDesk isn't running at ${BASE} (${why}). Start it on the Mac with: launchctl kickstart -k gui/$(id -u)/com.tubedesk  (first time: run ./install-mac.sh in the TubeDesk folder). Then try again.`);
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json?.error || `${method} ${path} → ${res.status}`);
  return json;
}

const runTool = createToolRunner(call);
const out = msg => process.stdout.write(JSON.stringify(msg) + '\n');
let pending = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async line => {
  if (!line.trim()) return;
  pending++;
  try {
    let req; try { req = JSON.parse(line); } catch { return; }
    const r = await handleMcpMessage(req, { runTool, base: BASE });
    if (r) out(r);
  } finally { pending--; }
});
process.stdin.on('end', () => { const t = setInterval(() => { if (pending === 0) { clearInterval(t); process.exit(0); } }, 20); });
