// Service worker: proxies requests from content scripts to the local TubeDesk server so the page never talks to localhost directly.
const DEFAULT_BASE = 'http://localhost:4949';

async function base() {
  const { tdBase } = await chrome.storage.sync.get('tdBase');
  return (tdBase || DEFAULT_BASE).replace(/\/$/, '');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const b = await base();
      const opts = { method: msg.method || 'GET', headers: {} };
      if (msg.body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(msg.body); }
      const res = await fetch(b + '/api' + msg.path, opts);
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = { error: text }; }
      sendResponse({ ok: res.ok, status: res.status, json, base: b });
    } catch (e) {
      sendResponse({ ok: false, status: 0, json: { error: 'TubeDesk is not running at ' + (await base()) + '. Start it with `npm start` (or the LaunchAgent).' } });
    }
  })();
  return true; // async
});
