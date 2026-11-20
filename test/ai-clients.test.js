// The AI-app config writers touch the owner's real files on every start: they must never break or lose anything.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'td-aic-home-'));
process.env.TUBEDESK_HOME = HOME;
process.env.TUBEDESK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'td-aic-data-'));
let ai, db;
const P = (...p) => path.join(HOME, ...p);
const read = (...p) => fs.readFileSync(P(...p), 'utf8');
const tomlOk = file => { try { execFileSync('python3', ['-c', 'import tomllib,sys; tomllib.load(open(sys.argv[1],"rb"))', file], { stdio: 'pipe' }); return true; } catch { return false; } };
const codex = async () => (await ai.connectAll({ only: ['codex'] }))[0];

before(async () => {
  db = await import('../src/db.js');
  db.setSetting('claude_cli_path', '/nonexistent/claude');
  ai = await import('../src/services/ai-clients.js');
  fs.mkdirSync(P('.codex'), { recursive: true });
});

test('Codex: a tubedesk server the user wrote in any TOML spelling is left alone (never a duplicate table)', async () => {
  const variants = [
    'mcp_servers.tubedesk.command = "node"\n',
    '[mcp_servers."tubedesk"]\ncommand = "node"\n',
    '[ mcp_servers.tubedesk ]\ncommand = "node"\n',
    '[mcp_servers]\ntubedesk = { command = "node" }\n',
    '[mcp_servers.tubedesk.env]\nX = "1"\n',
  ];
  for (const v of variants) {
    fs.writeFileSync(P('.codex', 'config.toml'), v);
    const r = await codex();
    assert.equal(r.parts.server, 'user-managed', v);
    assert.equal(read('.codex', 'config.toml'), v, 'untouched: ' + v);
  }
  // an inline mcp_servers table can't be extended: leave the file alone
  const inline = 'mcp_servers = { context7 = { command = "npx" } }\n';
  fs.writeFileSync(P('.codex', 'config.toml'), inline);
  assert.equal((await codex()).parts.server, 'unreadable');
  assert.equal(read('.codex', 'config.toml'), inline);
  // a repo path mentioning "tubedesk" inside another server is not mistaken for ours
  const other = '[mcp_servers.files]\ncommand = "npx"\nargs = ["/Users/me/tubedesk/data"]\n';
  fs.writeFileSync(P('.codex', 'config.toml'), other);
  assert.equal((await codex()).parts.server, 'added');
  assert.ok(tomlOk(P('.codex', 'config.toml')), 'still valid TOML');
  assert.ok(read('.codex', 'config.toml').startsWith(other));
});

test('a symlinked, permissioned config is updated in place: still a symlink, same mode, target changed', async () => {
  fs.mkdirSync(P('.cursor'), { recursive: true }); fs.mkdirSync(P('dotfiles'), { recursive: true });
  fs.writeFileSync(P('dotfiles', 'cursor-mcp.json'), JSON.stringify({ mcpServers: { secret: { command: 'x', env: { KEY: 'shh' } } } }));
  fs.chmodSync(P('dotfiles', 'cursor-mcp.json'), 0o600);
  fs.symlinkSync(P('dotfiles', 'cursor-mcp.json'), P('.cursor', 'mcp.json'));
  const r = (await ai.connectAll({ only: ['cursor'] }))[0];
  assert.equal(r.parts.server, 'added');
  assert.ok(fs.lstatSync(P('.cursor', 'mcp.json')).isSymbolicLink(), 'still a symlink');
  assert.ok(JSON.parse(read('dotfiles', 'cursor-mcp.json')).mcpServers.tubedesk, 'the real file got the entry');
  assert.equal(fs.statSync(P('dotfiles', 'cursor-mcp.json')).mode & 0o777, 0o600, 'permissions kept');
  assert.equal(fs.statSync(P('dotfiles', 'cursor-mcp.json.tubedesk-backup')).mode & 0o777, 0o600, 'backup not world-readable');
});

test('a read-only config is not replaced', async () => {
  fs.mkdirSync(P('.lmstudio'), { recursive: true });
  fs.writeFileSync(P('.lmstudio', 'mcp.json'), '{"mcpServers":{}}'); fs.chmodSync(P('.lmstudio', 'mcp.json'), 0o400);
  const r = (await ai.connectAll({ only: ['lmstudio'] }))[0];
  assert.equal(r.parts.server, 'unreadable');
  assert.equal(read('.lmstudio', 'mcp.json'), '{"mcpServers":{}}');
  fs.chmodSync(P('.lmstudio', 'mcp.json'), 0o600);
});

test('broken markers (user deleted the end marker) never wipe the user\'s rules', async () => {
  fs.mkdirSync(P('.gemini'), { recursive: true });
  const text = '# Rules\n<!-- tubedesk:start -->\nold TubeDesk rule\n\nIMPORTANT USER RULE KEEP ME\n';
  fs.writeFileSync(P('.gemini', 'GEMINI.md'), text);
  for (let i = 0; i < 2; i++) { const r = (await ai.connectAll({ only: ['gemini'] }))[0]; assert.equal(r.parts.rules, 'unreadable'); }
  assert.equal(read('.gemini', 'GEMINI.md'), text);
  // removal tidies only around our block
  fs.writeFileSync(P('.gemini', 'GEMINI.md'), '# Rules\n\n\n\nkeep   spacing\n\n\n\nend\n');
  await ai.connectAll({ only: ['gemini'], force: true });
  await ai.connectAll({ only: ['gemini'], remove: true });
  assert.equal(read('.gemini', 'GEMINI.md'), '# Rules\n\n\n\nkeep   spacing\n\n\n\nend\n');
});

test('an entry the user deleted by hand is not re-added at the next start; an explicit connect adds it back', async () => {
  fs.mkdirSync(P('.copilot'), { recursive: true });
  await ai.connectAll({ only: ['copilot'] });
  const f = P('.copilot', 'mcp-config.json');
  const o = JSON.parse(fs.readFileSync(f, 'utf8')); delete o.mcpServers.tubedesk; fs.writeFileSync(f, JSON.stringify(o));
  const r = (await ai.connectAll({ only: ['copilot'] }))[0];
  assert.equal(r.parts.server, 'removed-by-user'); assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers.tubedesk, undefined);
  assert.equal((await ai.connectAll({ only: ['copilot'], force: true }))[0].parts.server, 'added');
});

test('runs never overlap (startup + a connect from Settings at the same time)', async () => {
  fs.mkdirSync(P('Library', 'Application Support', 'Claude'), { recursive: true });
  const f = P('Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
  const rs = await Promise.all([ai.connectAll({ only: ['claude-desktop'] }), ai.connectAll({ only: ['claude-desktop'], force: true }), ai.connectAll({ only: ['claude-desktop'] })]);
  assert.deepEqual(rs.map(r => r[0].parts.server), ['added', 'ok', 'ok']);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(j.mcpServers.a && j.mcpServers.tubedesk);
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter(n => n.includes('tubedesk-tmp')), [], 'no temp files left');
});
