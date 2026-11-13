// TubeDesk Studio overlay (studio.youtube.com). On a video's Details page it reads the title, description and tags you are typing
// and shows a live score panel — SEO checklist, radar score (how this title compares with your channel's history), keyword demand,
// and tag suggestions you can add with one click. Nothing is saved automatically; you still press Save in Studio.
(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const call = (path, opts = {}) => new Promise(res => chrome.runtime.sendMessage({ path, ...opts }, res));
  const PANEL = 'td-studio';
  let lastSig = '', inflight = false, timer = null;

  function videoId() { const m = location.pathname.match(/\/video\/([\w-]{11})\/edit/); return m ? m[1] : null; }
  function field(sel) { const el = document.querySelector(sel); return el ? (el.textContent || el.value || '').trim() : ''; }
  function readForm() {
    const title = field('#title-textarea #textbox, ytcp-social-suggestions-textbox[label="Title"] #textbox, #title-textarea');
    const description = field('#description-textarea #textbox, ytcp-social-suggestions-textbox[label="Description"] #textbox, #description-textarea');
    const tags = [...document.querySelectorAll('ytcp-chip-bar ytcp-chip #chip-text, ytcp-form-input-container[label="Tags"] ytcp-chip #chip-text, #tags-container ytcp-chip #chip-text')].map(c => c.textContent.trim()).filter(Boolean);
    return { title, description, tags };
  }

  function mount() {
    let el = document.getElementById(PANEL); if (el) return el;
    const anchor = document.querySelector('#title-textarea')?.closest('ytcp-video-metadata-editor-basics, ytcp-video-metadata-editor') || document.querySelector('ytcp-video-metadata-editor-basics') || document.querySelector('#basics');
    if (!anchor) return null;
    el = document.createElement('div'); el.id = PANEL; el.className = 'td-root td-studio';
    anchor.insertAdjacentElement('afterbegin', el);
    return el;
  }

  const bar = (v, label, cls = '') => `<div class="td-stat ${cls}"><div class="v">${v === null || v === undefined ? '—' : v}</div><div class="l">${esc(label)}</div></div>`;
  const grade = s => s === null || s === undefined ? '' : s >= 75 ? 'ok' : s < 45 ? 'bad' : 'warn';
  const checks = list => `<ul class="td-checks">${(list || []).map(c => `<li class="${c.pass ? 'ok' : 'bad'}"><span>${c.pass ? '✓' : '✗'}</span> ${esc(c.name)}${c.detail ? ` <em>— ${esc(c.detail)}</em>` : ''}</li>`).join('')}</ul>`;

  function render(el, d, form) {
    if (!d) return;
    if (d.error) { el.innerHTML = `<div class="td-head"><span class="td-brand"><span class="td-logo"></span>TubeDesk</span></div><div class="td-err">${esc(d.error)}</div>`; return; }
    const r = d.radar && !d.radar.error ? d.radar : null;
    const pred = r?.prediction;
    const missingTags = (d.suggestedTags || []).filter(t => !form.tags.map(x => x.toLowerCase()).includes(t.toLowerCase())).slice(0, 10);
    el.innerHTML = `
      <div class="td-head"><span class="td-brand"><span class="td-logo"></span>TubeDesk · Studio</span><span class="td-badge">${d.isOwned ? 'known upload' : 'new upload'} · keyword: ${esc(d.keyword)}</span></div>
      <div class="td-grid">
        ${bar(d.seoScore, 'SEO score', grade(d.seoScore))}
        ${bar(r ? r.score : (d.radar?.error ? 'n/a' : '—'), 'radar score vs your history', grade(r?.score))}
        ${bar(pred?.multiplier ? pred.multiplier.toFixed(1) + '×' : '—', 'predicted vs usual views', pred?.multiplier ? (pred.multiplier >= 1.5 ? 'ok' : pred.multiplier < 0.8 ? 'bad' : '') : '')}
        ${bar(d.demand?.index ?? '—', `keyword demand${d.demand?.band ? ' · ' + d.demand.band : ''}`, grade(d.demand?.index))}
      </div>
      <div class="td-cols">
        <div><div class="td-label">Title ${d.title.score}/100</div>${checks(d.title.checks)}</div>
        <div><div class="td-label">Description ${d.description.score}/100</div>${checks(d.description.checks)}</div>
        <div><div class="td-label">Tags ${d.tags.score}/100</div>${checks(d.tags.checks)}
          ${missingTags.length ? `<div class="td-label">Suggested tags (click to copy)</div><div class="td-tags">${missingTags.map(t => `<button class="td-tag td-copy" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
        </div>
      </div>
      ${r?.advice?.length ? `<div class="td-label">Radar advice</div><ul class="td-advice">${r.advice.slice(0, 4).map(a => `<li>${esc(typeof a === 'string' ? a : a.text || a.fix || JSON.stringify(a))}</li>`).join('')}</ul>` : ''}
      ${r?.notes?.length ? `<div class="td-note">${esc(r.notes[0])}</div>` : ''}
      <div class="td-row"><a class="td-btn" href="http://localhost:4949/radar" target="_blank">Open radar</a><a class="td-btn" href="http://localhost:4949/packaging" target="_blank">Generate titles</a><span class="td-note">Scores update as you type. Nothing is changed until you press Save in Studio.</span></div>`;
    el.querySelectorAll('.td-copy').forEach(b => b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(b.dataset.t); b.textContent = 'copied ✓'; setTimeout(() => { b.textContent = b.dataset.t; }, 1200); } catch { /* clipboard blocked */ } }));
  }

  async function tick() {
    const vid = videoId();
    if (!vid) { document.getElementById(PANEL)?.remove(); lastSig = ''; return; }
    const el = mount(); if (!el) return;
    const form = readForm();
    if (!form.title) { if (!el.innerHTML) el.innerHTML = `<div class="td-head"><span class="td-brand"><span class="td-logo"></span>TubeDesk · Studio</span></div><div class="td-note">Type a title to get a live score.</div>`; return; }
    const sig = JSON.stringify([vid, form.title, form.description.slice(0, 400), form.tags]);
    if (sig === lastSig || inflight) return;
    inflight = true;
    try {
      const r = await call('/ext/studio', { method: 'POST', body: { videoId: vid, ...form } });
      lastSig = sig;
      render(el, r?.ok ? r.json : { error: r?.json?.error || 'TubeDesk not reachable' }, form);
    } finally { inflight = false; }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(tick, 700); };
  document.addEventListener('input', schedule, true);
  document.addEventListener('yt-navigate-finish', schedule);
  setInterval(tick, 2500);
  tick();
})();
