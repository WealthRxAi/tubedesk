/* TubeDesk front-end core: API client, hash router, state, rendering helpers, charts, drawer, toasts. */
window.TD = (() => {
  const state = { channels: [], current: null, status: null, views: {}, route: { path: '/', query: {} } };

  // ---------- helpers ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // h`…` escapes interpolated values. Strings produced by h itself (or raw()) carry an invisible sentinel
  // so nested templates and .map(...).join('') compose without double-escaping.
  const SENT = '\u2063\u2064';
  const isSafe = v => typeof v === 'string' && v.startsWith(SENT);
  const one = v => v && v.__raw !== undefined ? String(v.__raw).split(SENT).join('') : isSafe(v) ? v.split(SENT).join('') : esc(v);
  const safe = s => SENT + String(s ?? '').split(SENT).join('');
  const h = (strings, ...vals) => SENT + strings.reduce((acc, s, i) => acc + s + (i < vals.length ? (Array.isArray(vals[i]) ? vals[i].map(one).join('') : one(vals[i])) : ''), '').split(SENT).join('');
  const raw = s => ({ __raw: String(s ?? '') });
  const fmt = n => { if (n === null || n === undefined || Number.isNaN(n)) return '—'; n = Number(n); const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(Math.round(n)); };
  const fmtFull = n => n === null || n === undefined ? '—' : Number(n).toLocaleString();
  const pct = (x, d = 1) => x === null || x === undefined || Number.isNaN(x) ? '—' : (x * 100).toFixed(d) + '%';
  const toDate = iso => new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(iso) ? iso.replace(' ', 'T') + 'Z' : iso); // SQLite datetime('now') is UTC
  const ago = iso => { if (!iso) return '—'; const d = (Date.now() - toDate(iso)) / 86400000; if (d < 1) return Math.round(d * 24) + 'h ago'; if (d < 30) return Math.round(d) + 'd ago'; if (d < 365) return Math.round(d / 30) + 'mo ago'; return (d / 365).toFixed(1) + 'y ago'; };
  const dur = s => { s = Number(s || 0); const m = Math.floor(s / 60), ss = s % 60; return s >= 3600 ? `${Math.floor(s / 3600)}:${String(m % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`; };
  const date = iso => iso ? toDate(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const delta = x => x === null || x === undefined ? '' : safe(`<span class="${x >= 0 ? 'up' : 'down'}">${x >= 0 ? '▲' : '▼'} ${Math.abs(x * 100).toFixed(1)}%</span>`);
  const scoreClass = s => s >= 70 ? 'good' : s >= 45 ? 'mid' : 'low';
  const ytUrl = id => `https://www.youtube.com/watch?v=${id}`;

  // ---------- API ----------
  async function api(path, { method = 'GET', body, raw: rawBody = false } = {}) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch('/api' + path, opts);
    if (rawBody) return res;
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { error: text }; }
    if (!res.ok) { const e = new Error(json.error || res.statusText); e.status = res.status; e.reason = json.reason; throw e; }
    return json;
  }

  // ---------- toasts ----------
  function toast(msg, kind = '') {
    const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 8000 : 4000);
  }
  const err = e => { console.error(e); toast(e.message || String(e), 'err'); };

  // ---------- drawer ----------
  function openDrawer(html) { const d = document.getElementById('drawer'); document.getElementById('drawer-inner').innerHTML = html; d.classList.remove('hidden'); }
  function closeDrawer() { document.getElementById('drawer').classList.add('hidden'); }
  document.addEventListener('click', e => { if (e.target.id === 'drawer') closeDrawer(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

  // ---------- charts (inline SVG, no deps) ----------
  function lineChart(series, { width = 600, height = 160, labels = [], format = fmt, fill = true } = {}) {
    // series: [{name, values:[], cls}] all same length
    const pad = { l: 44, r: 10, t: 10, b: 22 };
    const all = series.flatMap(s => s.values).filter(v => Number.isFinite(v));
    if (!all.length) return safe('<div class="empty">No data yet</div>');
    const n = Math.max(...series.map(s => s.values.length));
    const max = Math.max(...all) || 1, min = Math.min(0, ...all);
    const x = i => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (width - pad.l - pad.r));
    const y = v => pad.t + (1 - (v - min) / (max - min || 1)) * (height - pad.t - pad.b);
    let out = `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`;
    for (let g = 0; g <= 3; g++) { const v = min + ((max - min) * g) / 3; out += `<line class="grid" x1="${pad.l}" x2="${width - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 4}" y="${y(v) + 3}" text-anchor="end">${format(v)}</text>`; }
    series.forEach((s, si) => {
      const pts = s.values.map((v, i) => Number.isFinite(v) ? `${x(i)},${y(v)}` : null).filter(Boolean);
      if (fill && si === 0) out += `<path class="area" d="M${x(0)},${y(min)} L${pts.join(' L')} L${x(s.values.length - 1)},${y(min)} Z"/>`;
      out += `<polyline class="line ${s.cls || (si ? 'b' : '')}" points="${pts.join(' ')}"/>`;
    });
    const step = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i += step) if (labels[i]) out += `<text x="${x(i)}" y="${height - 6}" text-anchor="middle">${esc(String(labels[i]).slice(5))}</text>`;
    return safe(out + '</svg>');
  }
  function barChart(values, { width = 600, height = 160, labels = [], format = fmt, cls = '' } = {}) {
    const pad = { l: 44, r: 10, t: 10, b: 22 };
    if (!values.length) return safe('<div class="empty">No data yet</div>');
    const max = Math.max(...values, 1);
    const bw = (width - pad.l - pad.r) / values.length;
    let out = `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`;
    for (let g = 0; g <= 3; g++) { const v = (max * g) / 3; const yy = pad.t + (1 - v / max) * (height - pad.t - pad.b); out += `<line class="grid" x1="${pad.l}" x2="${width - pad.r}" y1="${yy}" y2="${yy}"/><text x="${pad.l - 4}" y="${yy + 3}" text-anchor="end">${format(v)}</text>`; }
    values.forEach((v, i) => { const hh = (v / max) * (height - pad.t - pad.b); out += `<rect class="bar ${cls}" x="${pad.l + i * bw + bw * 0.15}" y="${height - pad.b - hh}" width="${bw * 0.7}" height="${hh}"><title>${esc(labels[i] ?? '')}: ${format(v)}</title></rect>`; });
    const step = Math.max(1, Math.ceil(values.length / 8));
    for (let i = 0; i < values.length; i += step) if (labels[i] !== undefined) out += `<text x="${pad.l + i * bw + bw / 2}" y="${height - 6}" text-anchor="middle">${esc(String(labels[i]).slice(0, 8))}</text>`;
    return safe(out + '</svg>');
  }
  function hbars(rows, { label = r => r.label, value = r => r.value, format = fmt, max = null } = {}) {
    const m = max || Math.max(...rows.map(value), 1);
    return safe(rows.map(r => `<div class="hbar"><span class="t" title="${esc(label(r))}">${esc(label(r))}</span><span class="b"><i style="width:${Math.min(100, (value(r) / m) * 100)}%"></i></span><span class="n">${format(value(r))}</span></div>`).join(''));
  }

  // ---------- common blocks ----------
  const videoCell = (v, { showChannel = false } = {}) => h`<div class="vt"><img class="thumb ${v.is_short ? 'v' : ''}" src="${v.thumbnail || ''}" loading="lazy" alt=""><div><div class="t">${v.title}</div><div class="m">${showChannel && (v.channel_title || v.channelTitle) ? (v.channel_title || v.channelTitle) + ' · ' : ''}${ago(v.published_at)}${v.duration_sec ? ' · ' + dur(v.duration_sec) : ''}${v.is_short ? ' · Short' : ''}</div></div></div>`;
  const stat = (label, value, d) => safe(`<div class="card tight stat"><span class="v">${value}</span><span class="l">${esc(label)}</span>${d !== undefined ? `<span class="d">${d}</span>` : ''}</div>`);
  const checks = list => safe(list.map(c => `<div class="check ${c.pass ? 'pass' : 'fail'}"><i>${c.pass ? '✓' : '✕'}</i><div><div>${esc(c.name || c.item)}</div>${c.detail ? `<div class="d">${esc(c.detail)}</div>` : ''}</div></div>`).join(''));
  const scoreRing = s => safe(`<span class="score ${scoreClass(s)}">${Math.round(s)}</span>`);
  const empty = (msg, extra = '') => safe(`<div class="empty">${msg}${extra}</div>`);
  const needOwned = () => empty('<b>Select an owned channel first.</b><br>Add one under Channels — connect with Google for analytics, or add by ID for public data.');
  const needAuth = ch => empty(`<b>${esc(ch.title)} is not connected with Google.</b><br>Owner analytics (retention, traffic sources, demographics, subscribers) require authorization. Go to Channels → Connect with Google.`);
  const busy = (btn, on) => { if (!btn) return; btn.disabled = on; if (on) { btn.dataset.t = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span> ' + btn.dataset.t; } else btn.innerHTML = btn.dataset.t || btn.innerHTML; };
  function downloadText(name, text, type = 'text/csv') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); }
  function csvFrom(rows, cols) { if (!rows.length) return ''; cols = cols || Object.keys(rows[0]); const e = v => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }; return [cols.join(','), ...rows.map(r => cols.map(c => e(r[c])).join(','))].join('\n'); }
  function sortTable(rows, key, dir) { return [...rows].sort((a, b) => { const x = a[key], y = b[key]; if (x === y) return 0; if (typeof x === 'number' || typeof y === 'number') return (dir === 'asc' ? 1 : -1) * ((x ?? -Infinity) - (y ?? -Infinity)); return (dir === 'asc' ? 1 : -1) * String(x ?? '').localeCompare(String(y ?? '')); }); }
  function ls(key, val) { if (val === undefined) { try { return JSON.parse(localStorage.getItem('td:' + key)); } catch { return null; } } localStorage.setItem('td:' + key, JSON.stringify(val)); }
  function copy(text) { navigator.clipboard.writeText(text).then(() => toast('Copied')); }
  function mdLite(text) { // minimal markdown → html (headings, bold, lists)
    return safe(esc(text).replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h2>$1</h2>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^\s*[-*] (.*)$/gm, '<div>• $1</div>').replace(/^\s*(\d+)\. (.*)$/gm, '<div>$1. $2</div>'));
  }

  // ---------- router / nav ----------
  const NAV = [
    { group: 'Desk' },
    { path: '/', label: 'Dashboard' }, { path: '/channels', label: 'Channels' }, { path: '/library', label: 'Video library' }, { path: '/analytics', label: 'Analytics', owned: true },
    { group: 'Research' },
    { path: '/keywords', label: 'Keywords' }, { path: '/outliers', label: 'Outliers' }, { path: '/trending', label: 'Trending & niches' }, { path: '/competitors', label: 'Competitors' }, { path: '/boards', label: 'Boards & blueprints' },
    { group: 'Create' },
    { path: '/packaging', label: 'Packaging' }, { path: '/coach', label: 'AI coach' }, { path: '/production', label: 'Production' }, { path: '/comments', label: 'Comments' },
    { group: 'System' },
    { path: '/calculators', label: 'Calculators' }, { path: '/settings', label: 'Settings' },
  ];
  function parseHash() { const hs = location.hash.replace(/^#/, '') || '/'; const [path, qs] = hs.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || '')); return { path: path || '/', query }; }
  function go(path, query = {}) { const qs = new URLSearchParams(query).toString(); location.hash = path + (qs ? '?' + qs : ''); }
  function renderNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = NAV.map(n => n.group ? `<div class="group">${n.group}</div>` : `<a href="#${n.path}" class="${state.route.path === n.path || (n.path !== '/' && state.route.path.startsWith(n.path + '/')) ? 'active' : ''}">${n.label}${n.path === '/competitors' && state.alertCount ? `<span class="badge bad">${state.alertCount}</span>` : ''}</a>`).join('');
  }
  function renderSwitch() {
    const sw = document.getElementById('channel-switch');
    const owned = state.channels.filter(c => c.kind === 'owned');
    if (!owned.length) { sw.innerHTML = `<a class="btn" href="#/channels" style="width:100%;justify-content:center">+ Add your channel</a>`; return; }
    sw.innerHTML = `<select id="ch-select">${owned.map(c => `<option value="${c.id}" ${state.current?.id === c.id ? 'selected' : ''}>${esc(c.title)}${c.authorized ? '' : ' (public only)'}</option>`).join('')}</select>`;
    document.getElementById('ch-select').onchange = e => { setCurrent(e.target.value); route(); };
  }
  function renderFoot() {
    const s = state.status; if (!s) return;
    const q = s.quota; const p = Math.min(100, (q.units / q.limit) * 100);
    document.getElementById('side-foot').innerHTML = `<div>API quota today: ${fmtFull(q.units)} / ${fmtFull(q.limit)}</div><div class="bar"><i style="width:${p}%;background:${p > 85 ? 'var(--bad)' : p > 60 ? 'var(--warn)' : 'var(--info)'}"></i></div><div>AI: ${s.ai.ok ? '<span class="up">●</span> ' + esc(s.ai.provider) : '<span class="down">●</span> ' + esc(s.ai.detail)}</div>`;
  }
  function setCurrent(id) { state.current = state.channels.find(c => c.id === id) || null; if (state.current) ls('current', state.current.id); renderSwitch(); }
  async function refreshChannels() {
    state.channels = await api('/channels');
    const owned = state.channels.filter(c => c.kind === 'owned');
    const saved = ls('current');
    state.current = owned.find(c => c.id === saved) || owned[0] || null;
    renderSwitch();
    if (state.current) { try { const al = await api(`/alerts/${state.current.id}?unread=1`); state.alertCount = al.length; } catch { state.alertCount = 0; } }
  }
  async function refreshStatus() { try { state.status = await api('/status'); renderFoot(); } catch (e) { console.error(e); } }

  const views = {};
  function view(path, fn) { views[path] = fn; }
  async function route() {
    state.route = parseHash();
    renderNav();
    const main = document.getElementById('main');
    const base = '/' + state.route.path.split('/')[1];
    const fn = views[state.route.path] || views[base];
    if (!fn) { main.innerHTML = empty('Page not found'); return; }
    main.innerHTML = '<div class="loading"><span class="spinner"></span> Loading…</div>';
    try { await fn(main, state.route); } catch (e) { main.innerHTML = `<div class="note bad">${esc(e.message)}</div>`; console.error(e); }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  async function start() {
    await refreshStatus();
    try { await refreshChannels(); } catch (e) { err(e); }
    if (!state.status?.configured?.apiKey && parseHash().path !== '/settings') { location.hash = '/settings?setup=1'; }
    await route();
    setInterval(refreshStatus, 60000);
  }

  // Shared "video detail" drawer hook (defined in views-library.js)
  const openVideo = id => (state.views.openVideo ? state.views.openVideo(id) : go('/library', { v: id }));

  return { state, api, h, raw, safe, esc, fmt, fmtFull, pct, ago, dur, date, delta, scoreClass, ytUrl, toast, err, openDrawer, closeDrawer, lineChart, barChart, hbars, videoCell, stat, checks, scoreRing, empty, needOwned, needAuth, busy, downloadText, csvFrom, sortTable, ls, copy, mdLite, view, route, go, start, refreshChannels, setCurrent, openVideo, refreshStatus };
})();
