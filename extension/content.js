// TubeDesk content script. Three surfaces, like vidIQ:
//  1. Watch page: stats panel (views, VPH, est. revenue, outlier ×, engagement, SEO, tags) + channel card (est. monthly revenue, cadence, recent breakouts).
//  2. Channel page: channel panel (stats, est. monthly/yearly revenue, uploads/week, median views, recent uploads with outlier ×).
//  3. Every thumbnail (home, search, related, channel grids, Shorts shelves): chips with views/day, age, est. revenue.
//  4. Search page: keyword demand panel.
// YouTube is a SPA, so we watch for navigation and re-render. All data comes from the local TubeDesk server via the service worker.
(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => { if (n === null || n === undefined || Number.isNaN(n)) return '—'; n = Number(n); const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(Math.round(n)); };
  const money = n => { if (n === null || n === undefined) return '—'; n = Number(n); if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'; if (n >= 100) return '$' + Math.round(n); return '$' + n.toFixed(2); };
  const range = (lo, hi) => `${money(lo)}–${money(hi)}`;
  const ago = d => d < 1 ? 'today' : d < 30 ? d + 'd' : d < 365 ? Math.round(d / 30) + 'mo' : (d / 365).toFixed(1) + 'y';
  const dur = s => { s = Math.round(s || 0); const m = Math.floor(s / 60), h = Math.floor(m / 60); return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; };
  const call = (path, opts = {}) => new Promise(res => chrome.runtime.sendMessage({ path, ...opts }, res));
  let lastKey = '';
  let BASE = 'http://localhost:4949';

  function videoId() { try { const u = new URL(location.href); if (u.pathname === '/watch') return u.searchParams.get('v'); const m = u.pathname.match(/^\/shorts\/([\w-]{11})/); return m ? m[1] : null; } catch { return null; } }
  function searchQuery() { try { const u = new URL(location.href); return u.pathname === '/results' ? u.searchParams.get('search_query') : null; } catch { return null; } }
  function channelRef() { try { const p = new URL(location.href).pathname.split('/').filter(Boolean); if (!p.length) return null; if (p[0].startsWith('@')) return p[0]; if (p[0] === 'channel' && p[1]) return p[1]; if ((p[0] === 'c' || p[0] === 'user') && p[1]) return `https://www.youtube.com/${p[0]}/${p[1]}`; return null; } catch { return null; } }

  const header = (right = '') => `<div class="td-head"><span class="td-brand"><span class="td-logo"></span>TubeDesk</span><span>${right}</span></div>`;
  const stat = (v, l, cls = '', title = '') => `<div class="td-stat ${cls}" title="${esc(title)}"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`;
  const oxCls = ox => ox === null || ox === undefined ? '' : ox >= 3 ? 'ok' : ox < 0.5 ? 'bad' : '';

  function mount(id, anchorSel, where) {
    const existing = document.getElementById(id); if (existing) return existing;
    let anchor = null; for (const s of anchorSel) { anchor = document.querySelector(s); if (anchor) break; }
    if (!anchor) return null;
    const el = document.createElement('div'); el.id = id; el.className = 'td-root';
    anchor.insertAdjacentElement(where(anchor), el);
    return el;
  }
  const mountWatch = () => mount('td-panel', ['#below #above-the-fold', 'ytd-watch-metadata', '#below', '#secondary', 'ytd-reel-video-renderer[is-active] #actions'], a => a.id === 'secondary' ? 'afterbegin' : 'afterend');
  const mountSearch = () => mount('td-search', ['ytd-search #contents', 'ytd-two-column-search-results-renderer #primary', '#primary'], () => 'afterbegin');
  const mountChannel = () => mount('td-channel', ['ytd-browse[page-subtype="channels"] #contentContainer tp-yt-app-header', 'ytd-browse[page-subtype="channels"] #header', 'yt-page-header-renderer', '#channel-header', 'ytd-browse #header'], () => 'afterend');

  function recentList(recent) {
    return `<div class="td-list">${recent.map(r => `<a class="td-item" href="/watch?v=${esc(r.id)}"><img src="${esc(r.thumbnail || '')}"><span class="t">${esc(r.title)}</span><span class="m">${fmt(r.view_count)} · ${ago(r.ageDays)}${r.is_short ? ' · Short' : ''}</span><span class="x ${oxCls(r.outlierX)}">${r.outlierX === null ? '—' : r.outlierX.toFixed(1) + '×'}</span><span class="m">${range(r.est.low, r.est.high)}</span></a>`).join('')}</div>`;
  }
  function channelCard(c, s, opts = {}) {
    if (!c || !s) return '';
    const m = s.monthly;
    return `<div class="td-sub">
      <div class="td-subhead"><img src="${esc(c.thumbnail || '')}"><div><div class="t">${esc(c.title)} ${opts.badge || ''}</div><div class="m">${esc(c.handle || '')} · ${fmt(c.subscriber_count)} subs · ${fmt(c.view_count)} views · ${fmt(c.video_count)} videos${s.ageDays ? ' · ' + ago(s.ageDays) + ' old' : ''}${c.country ? ' · ' + esc(c.country) : ''}</div></div></div>
      <div class="td-grid">
        ${stat(range(m.low, m.high), 'est. monthly revenue', 'money', m.note)}
        ${stat(range(m.yearlyLow, m.yearlyHigh), 'est. yearly revenue', 'money', m.note)}
        ${stat(fmt(m.monthlyViews), 'est. views / month', '', 'From recent-upload view velocity')}
        ${stat(s.uploadsPerWeek, 'uploads / week')}
        ${stat(fmt(s.medianLongViews), 'median long-form views')}
        ${stat(fmt(s.medianShortViews), 'median Shorts views')}
        ${stat(fmt(s.avgViewsPerVideo), 'lifetime avg views / video')}
        ${stat(s.viewsPerSub === null ? '—' : s.viewsPerSub.toFixed(0) + '×', 'lifetime views ÷ subs')}
      </div>
      <div class="td-note">RPM band: ${esc(m.niche)} (${m.shortsShare}% of recent views are Shorts). Revenue is an estimate from public views × niche RPM — the same method other tools use. Real numbers exist only for channels you connect.</div>
      ${s.breakouts?.length ? `<div class="td-label">Recent breakouts (≥3× this channel's median)</div>${recentList(s.breakouts)}` : ''}
      ${opts.showRecent && s.recent?.length ? `<div class="td-label">Recent uploads</div>${recentList(s.recent)}` : ''}
    </div>`;
  }

  async function renderWatch(id) {
    const el = mountWatch(); if (!el) return;
    el.innerHTML = header('<span class="td-mini">loading…</span>');
    const r = await call(`/ext/video/${id}`);
    if (!r || !r.ok) { el.innerHTML = header() + `<div class="td-err">${esc(r?.json?.error || 'TubeDesk unreachable')}</div><div class="td-note">Start TubeDesk, or set its address in the extension options.</div>`; return; }
    BASE = r.base || BASE;
    const d = r.json, v = d.video, c = d.channel, ox = d.outlierX;
    const fresh = d.ageHours < 72;
    el.innerHTML = header(`<span class="td-badge">${esc(d.format)}</span> ${v.is_short ? '<span class="td-badge">Short</span>' : ''} ${d.isOwned ? '<span class="td-badge ok">your channel</span>' : d.isTracked ? '<span class="td-badge">tracked</span>' : ''}`) +
      `<div class="td-grid">
        ${stat(fmt(v.view_count), 'views')}
        ${stat(fresh ? fmt(d.vph) + '/hr' : fmt(d.vpd) + '/day', fresh ? `views per hour (${d.ageHours}h old)` : `views per day (${ago(d.ageDays)} old)`)}
        ${stat(range(d.est.low, d.est.high), 'est. video revenue', 'money', `RPM band ${d.est.niche}: $${d.est.rpmLow}–$${d.est.rpmHigh} per 1,000 views`)}
        ${stat(ox === null ? '—' : ox.toFixed(1) + '×', `vs channel median (${d.baseline?.sample || 0} videos)`, oxCls(ox))}
        ${stat(d.velocityX === null ? '—' : d.velocityX.toFixed(1) + '×', 'velocity vs channel', d.velocityX !== null && d.velocityX >= 2 ? 'ok' : '')}
        ${stat(fmt(v.like_count), `likes (${(d.likeRate * 100).toFixed(1)}%)`)}
        ${stat(fmt(v.comment_count), `comments (${(d.commentRate * 100).toFixed(2)}%)`)}
        ${stat(d.subsRatio === null ? '—' : d.subsRatio.toFixed(2) + '×', 'views ÷ subscribers', d.subsRatio !== null && d.subsRatio >= 1 ? 'ok' : '')}
        ${stat(d.seoScore, 'SEO score (title · description · tags)', d.seoScore >= 70 ? 'ok' : d.seoScore < 45 ? 'bad' : 'warn', `title ${d.titleScore} · description ${d.descScore} · ${v.tags?.length || 0} tags`)}
        ${stat(dur(v.duration_sec), 'length')}
        ${stat(new Date(v.published_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }), 'published')}
        ${stat(v.tags?.length || 0, 'tags')}
      </div>
      ${v.tags?.length ? `<div class="td-tags">${v.tags.slice(0, 40).map(t => `<span class="td-tag">${esc(t)}</span>`).join('')}</div>` : '<div class="td-note">No tags on this video.</div>'}
      <div class="td-row">
        ${!d.isOwned && !d.isTracked ? `<button class="td-btn primary" id="td-track">Track channel as competitor</button>` : ''}
        <button class="td-btn" id="td-save">Save to board</button>
        <button class="td-btn" id="td-copytags">Copy tags</button>
        <a class="td-btn" target="_blank" href="${esc(BASE)}/#/library?v=${esc(v.id)}">Open in TubeDesk</a>
        <a class="td-btn" target="_blank" href="${esc(BASE)}/#/keywords?q=${encodeURIComponent(v.title.split(/[|:\-–(]/)[0].trim())}">Research this topic</a>
      </div>
      ${channelCard(c, d.channelSummary)}
      <div class="td-note">Median is from this channel's last ${d.baseline?.sample || 0} same-format uploads. Public data via YouTube Data API; quota is spent once per video and cached.</div>`;
    const tr = el.querySelector('#td-track'); if (tr) tr.onclick = async () => { tr.disabled = true; tr.textContent = 'Tracking…'; const x = await call('/ext/track', { method: 'POST', body: { channelId: v.channel_id } }); tr.textContent = x.ok ? `Tracking ${x.json.title}` : (x.json?.error || 'Failed'); };
    el.querySelector('#td-save').onclick = async e => { e.target.disabled = true; const x = await call('/ext/save', { method: 'POST', body: { ref: { id: v.id, title: v.title, thumbnail: v.thumbnail, channel_title: v.channel_title, view_count: v.view_count } } }); e.target.textContent = x.ok ? `Saved to ${x.json.board}` : (x.json?.error || 'Failed'); };
    el.querySelector('#td-copytags').onclick = async e => { try { await navigator.clipboard.writeText((v.tags || []).join(', ')); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Copy blocked'; } };
  }

  async function renderChannel(ref) {
    const el = mountChannel(); if (!el) return;
    el.innerHTML = header('<span class="td-mini">loading channel…</span>');
    const r = await call(`/ext/channel?ref=${encodeURIComponent(ref)}`);
    if (!r || !r.ok) { el.innerHTML = header() + `<div class="td-err">${esc(r?.json?.error || 'TubeDesk unreachable')}</div>`; return; }
    BASE = r.base || BASE;
    const d = r.json, c = d.channel;
    el.innerHTML = header(d.isOwned ? '<span class="td-badge ok">your channel</span>' : d.isTracked ? '<span class="td-badge">tracked</span>' : '') +
      channelCard(c, d.summary, { showRecent: true }) +
      `<div class="td-row">
        ${!d.isOwned && !d.isTracked ? `<button class="td-btn primary" id="td-track">Track as competitor</button>` : ''}
        <a class="td-btn" target="_blank" href="${esc(BASE)}/#/outliers?channel=${esc(c.id)}">Outliers in TubeDesk</a>
        <a class="td-btn" target="_blank" href="${esc(BASE)}/#/competitors">Compare with my channel</a>
      </div>`;
    const tr = el.querySelector('#td-track'); if (tr) tr.onclick = async () => { tr.disabled = true; tr.textContent = 'Tracking…'; const x = await call('/ext/track', { method: 'POST', body: { channelId: c.id } }); tr.textContent = x.ok ? `Tracking ${x.json.title}` : (x.json?.error || 'Failed'); };
  }

  async function renderSearch(q) {
    const el = mountSearch(); if (!el) return;
    el.innerHTML = header('<span class="td-mini">checking demand…</span>');
    const r = await call(`/ext/keyword?q=${encodeURIComponent(q)}`);
    if (!r || !r.ok) { el.innerHTML = header() + `<div class="td-err">${esc(r?.json?.error || 'TubeDesk unreachable')}</div>`; return; }
    BASE = r.base || BASE;
    const d = r.json.demand, comp = r.json.competition;
    const bandCls = d.band === 'high' ? 'ok' : d.band === 'moderate' ? 'warn' : 'bad';
    el.innerHTML = header(`<span class="td-badge ${bandCls}">demand ${esc(d.band)}</span>`) +
      `<div class="td-grid">
        ${stat(d.demandIndex, 'demand index (0–100)', bandCls)}
        ${stat(d.regionsPresent.length + '/5', 'regions autocompleting it')}
        ${stat(d.homeRank ? '#' + d.homeRank : '—', 'autocomplete rank')}
        ${stat(comp ? comp.score : '—', comp ? `opportunity (checked ${esc(comp.day)})` : 'opportunity (not checked yet)', comp ? (comp.score >= 60 ? 'ok' : comp.score >= 35 ? 'warn' : 'bad') : '')}
      </div>
      <div class="td-row">
        <a class="td-btn primary" target="_blank" href="${esc(BASE)}${esc(r.json.openUrl)}">Competition evidence (100 quota units)</a>
        <a class="td-btn" target="_blank" href="${esc(BASE)}/#/outliers?mode=search&q=${encodeURIComponent(q)}">Find outliers for this topic</a>
      </div>
      <div class="td-note">${esc(d.note)}</div>`;
  }

  // ---- Thumbnail chips (every grid/list/shelf) ----
  const chipCache = new Map(); // videoId -> data | null
  let chipInflight = false;
  const THUMB_SEL = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model, yt-lockup-view-model';
  function idFromCard(card) {
    const a = card.querySelector('a[href*="/watch?v="], a[href^="/shorts/"]'); if (!a) return null;
    const m = a.getAttribute('href').match(/[?&]v=([\w-]{11})|\/shorts\/([\w-]{11})/); return m ? (m[1] || m[2]) : null;
  }
  function thumbHost(card) { return card.querySelector('ytd-thumbnail, yt-thumbnail-view-model, .shortsLockupViewModelHostThumbnail, a#thumbnail, .yt-lockup-view-model-wiz__content-image') || card; }
  function paintChip(card, id, d) {
    if (card.querySelector('.td-chip')) return;
    const host = thumbHost(card); if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const chip = document.createElement('div'); chip.className = 'td-chip';
    if (!d) { chip.classList.add('muted'); chip.textContent = 'n/a'; host.appendChild(chip); return; }
    const vs = d.vsChannelAvg, cls = vs === null ? '' : vs >= 2 ? 'ok' : vs < 0.5 ? 'bad' : '';
    const rate = d.ageDays < 3 ? fmt(d.vph) + '/hr' : fmt(d.vpd) + '/day';
    chip.innerHTML = `<span>${fmt(d.views)}</span><span>${rate}</span><span class="${cls}" title="views vs this channel's lifetime average per video">${vs === null ? '' : vs.toFixed(1) + '×'}</span><span class="money" title="est. revenue (RPM band ${esc(d.est.niche)})">${range(d.est.low, d.est.high)}</span>`;
    chip.title = `${d.views.toLocaleString()} views · ${d.likes.toLocaleString()} likes · ${d.comments.toLocaleString()} comments · ${ago(d.ageDays)} old · ${fmt(d.subs)} subs`;
    host.appendChild(chip);
  }
  async function tickChips() {
    if (chipInflight) return;
    const cards = [...document.querySelectorAll(THUMB_SEL)].filter(c => !c.querySelector('.td-chip'));
    const pending = [], want = new Set();
    for (const card of cards) {
      const id = idFromCard(card); if (!id) continue;
      if (chipCache.has(id)) paintChip(card, id, chipCache.get(id)); else { pending.push([card, id]); want.add(id); }
    }
    if (!want.size) return;
    chipInflight = true;
    try {
      const ids = [...want].slice(0, 50);
      const r = await call(`/ext/videos?ids=${ids.join(',')}`);
      if (r?.ok) { for (const id of ids) chipCache.set(id, r.json.videos[id] || null); for (const [card, id] of pending) if (chipCache.has(id)) paintChip(card, id, chipCache.get(id)); }
    } finally { chipInflight = false; }
  }

  async function tick() {
    const v = videoId(), q = searchQuery(), c = !v && !q ? channelRef() : null;
    const key = v ? 'v:' + v : q ? 'q:' + q : c ? 'c:' + c : '';
    if (key !== lastKey) {
      lastKey = key;
      document.getElementById('td-panel')?.remove(); document.getElementById('td-search')?.remove(); document.getElementById('td-channel')?.remove();
      if (v) await renderWatch(v); else if (q) await renderSearch(q); else if (c) await renderChannel(c);
    } else if (key) {
      // YouTube re-renders containers; re-mount if ours was dropped.
      if (v && !document.getElementById('td-panel')) lastKey = '';
      if (q && !document.getElementById('td-search')) lastKey = '';
      if (c && !document.getElementById('td-channel')) lastKey = '';
    }
    tickChips();
  }
  document.addEventListener('yt-navigate-finish', () => setTimeout(tick, 400));
  setInterval(tick, 1500);
  tick();
})();
