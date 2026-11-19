#!/usr/bin/env node
// Keeps the Claude plugin in step with TubeDesk: copies the MCP server into plugin/, stamps the plugin and skill
// versions from package.json, and (with --zip) writes dist/tubedesk.plugin for the Claude desktop app.
//   npm run plugin          sync only
//   npm run plugin -- --zip sync + package
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const PLUGIN = path.join(ROOT, 'plugin');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

for (const f of ['server.js', 'tools.js']) fs.copyFileSync(path.join(ROOT, 'mcp', f), path.join(PLUGIN, 'mcp', f));
const manifestPath = path.join(PLUGIN, '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
for (const dir of fs.readdirSync(path.join(PLUGIN, 'skills'))) {
  const f = path.join(PLUGIN, 'skills', dir, 'SKILL.md');
  if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^(\s+version: )"[^"]*"/m, `$1"${version}"`));
}
console.log(`plugin synced (v${version})`);

if (process.argv.includes('--zip')) {
  const out = path.join(ROOT, 'dist', 'tubedesk.plugin');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-qr', out, '.', '-x', '*.DS_Store'], { cwd: PLUGIN });
  console.log(`wrote ${path.relative(ROOT, out)}`);
}
