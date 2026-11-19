// The Claude plugin: manifest/marketplace are valid, the bundled MCP server is the repo's, every tool a skill tells
// Claude to call exists, the MCP server explains when TubeDesk is down, and TubeDesk serves the .plugin download.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const PLUGIN = path.join(ROOT, 'plugin');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

function mcp(env = {}) {
  const child = spawn(process.execPath, [path.join(PLUGIN, 'mcp', 'server.js')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const waiting = new Map();
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); waiting.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return { rpc, close: () => child.kill() };
}

let server, base, dataDir;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-plugin-'));
  const port = 6100 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), TUBEDESK_DATA_DIR: dataDir, TUBEDESK_NO_SCHEDULER: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/status'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
});
after(() => server?.kill());

test('manifest, marketplace and skills are well-formed and versioned with TubeDesk', () => {
  const m = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(m.name, 'tubedesk');
  assert.equal(m.version, pkg.version, 'run npm run plugin');
  const mk = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.equal(mk.plugins[0].name, 'tubedesk');
  assert.equal(path.resolve(ROOT, mk.plugins[0].source), PLUGIN);
  const servers = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(servers.tubedesk.args, ['${CLAUDE_PLUGIN_ROOT}/mcp/server.js']);
  const skills = fs.readdirSync(path.join(PLUGIN, 'skills'));
  assert.deepEqual(skills.sort(), ['channel-checkup', 'make-shorts', 'package-video', 'publish-video', 'tubedesk', 'video-ideas']);
  for (const s of skills) {
    const md = fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
    assert.ok(fm, s + ': frontmatter');
    assert.match(fm[1], new RegExp(`^name: ${s}$`, 'm'));
    assert.match(fm[1], /^description: >\n\s+This skill should be used when/m);
    assert.match(fm[1], new RegExp(`version: "${pkg.version.replace(/\./g, '\\.')}"`), s + ': version stamped');
    assert.ok(md.split(/\s+/).length < 3000, s + ': lean');
  }
});

test('the bundled MCP server is the repo one', () => {
  assert.equal(fs.readFileSync(path.join(PLUGIN, 'mcp', 'server.js'), 'utf8'), read('mcp/server.js'), 'run npm run plugin');
});

test('every tool the skills name exists, and every API route they name exists', async () => {
  const c = mcp({ TUBEDESK_URL: base });
  await c.rpc('initialize', { protocolVersion: '2024-11-05' });
  const tools = new Set((await c.rpc('tools/list')).result.tools.map(t => t.name));
  c.close();
  const flat = (await (await fetch(base + '/api/agent')).text()).replace(/[ \t]+/g, ' ');
  for (const s of fs.readdirSync(path.join(PLUGIN, 'skills'))) {
    const md = fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
    for (const [, name] of md.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) assert.ok(tools.has(name), `${s}: tool ${name} does not exist`);
    for (const [, method, route] of md.matchAll(/`tubedesk_api (GET|POST) (\/api\/[^`\s]+)`?/g)) {
      const pattern = route.replace(/<[^>]+>/g, ':x').replace(/^\/api/, '');
      const head = pattern.split('/:x')[0];
      assert.ok(flat.includes(`${method} /api${head}`), `${s}: ${method} ${route} not in the agent guide`);
    }
  }
});

test('MCP tools explain how to start TubeDesk when it is not running', async () => {
  const free = await new Promise(r => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });
  const c = mcp({ TUBEDESK_URL: `http://127.0.0.1:${free}` });
  await c.rpc('initialize', { protocolVersion: '2024-11-05' });
  const r = await c.rpc('tools/call', { name: 'list_channels', arguments: {} });
  c.close();
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /TubeDesk isn't running at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\).*launchctl kickstart -k gui\/\$\(id -u\)\/com\.tubedesk/);
});

test('TubeDesk serves the plugin for the Claude desktop app', async () => {
  const res = await fetch(base + '/api/plugin/download');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /tubedesk\.plugin/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const f = path.join(dataDir, 'dl.plugin'); fs.writeFileSync(f, buf);
  const list = execFileSync('unzip', ['-l', f]).toString();
  for (const p of ['.claude-plugin/plugin.json', '.mcp.json', 'mcp/server.js', 'skills/tubedesk/SKILL.md', 'skills/publish-video/SKILL.md']) assert.ok(list.includes(p), p);
});
