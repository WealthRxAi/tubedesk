#!/usr/bin/env node
// Stand-in for the tailscale CLI: `status --json`, `funnel --bg --yes <port>`, `funnel status --json`, `funnel --https=443 off`.
// State lives in $FAKE_TS_STATE (JSON). FAKE_TS_MODE=needs-approval makes the first funnel call ask for tailnet approval.
import fs from 'node:fs';
const file = process.env.FAKE_TS_STATE;
const st = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { funnel: null, asked: false };
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const a = process.argv.slice(2);
if (a[0] === 'status' && a.includes('--json')) { console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'salmans-mac-mini.tail1234.ts.net.' } })); process.exit(0); }
if (a[0] === 'funnel' && a[1] === 'status') {
  console.log(JSON.stringify(st.funnel ? { TCP: { 443: { HTTPS: true } }, Web: { 'salmans-mac-mini.tail1234.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${st.funnel}` } } } }, AllowFunnel: { 'salmans-mac-mini.tail1234.ts.net:443': true } } : {}));
  process.exit(0);
}
if (a[0] === 'funnel' && a.includes('off')) { st.funnel = null; save(); process.exit(0); }
if (a[0] === 'funnel' && a.includes('--bg')) {
  if (process.env.FAKE_TS_MODE === 'needs-approval' && !st.asked) { st.asked = true; save(); console.error('Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=abc123\n'); process.exit(1); }
  st.funnel = Number(a[a.length - 1]); save();
  console.log(`Available on the internet:\n\nhttps://salmans-mac-mini.tail1234.ts.net/\n|-- proxy http://127.0.0.1:${st.funnel}\n\nFunnel started and running in the background.`);
  process.exit(0);
}
console.error('fake-tailscale: unsupported ' + a.join(' ')); process.exit(2);
