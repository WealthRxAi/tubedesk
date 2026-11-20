/* v2.1 screens: Outlier index (+ niches, title formulas, similar thumbnails), Rank tracker, Bulk editor,
   Make a video, Health (check-up, jobs, backups, updates, phone). */
(() => {
  const { view, api, h, raw, fmt, fmtFull, empty, stat, toast, err, busy, state, ago, needOwned } = TD;
  const xfmt = v => v === null || v === undefined ? '—' : (v >= 10 ? Math.round(v) : (+v).toFixed(1)) + '×';
  const thumbRow = r => h`<tr><td style="width:132px"><a href="https://youtu.be/${r.id || r.videoId}" target="_blank"><img src="${r.thumbnail}" style="width:124px;border-radius:6px"></a></td>
    <td><a href="https://youtu.be/${r.id || r.videoId}" target="_blank">${r.title || ''}</a><div class="mini">${r.channel_title || r.channel || ''}${r.channel_subs ? ` · ${fmt(r.channel_subs)} subs` : ''}</div></td>
    <td class="num">${fmt(r.views)}</td><td class="num"><b>${xfmt(r.x)}</b></td>${r.similarity !== undefined ? h`<td class="num">${Math.round(r.similarity * 100)}%</td>` : ''}</tr>`;

  // ---------- Outlier index ----------
  view('/index', async (main, route) => {
    const q = route?.query || {};
    const tab = q.tab || 'outliers';
    const tabs = [['outliers', 'Outliers'], ['niches', 'Niche finder'], ['formulas', 'Title formulas'], ['thumbs', 'Similar thumbnails']];
    main.innerHTML = h`<div class="page-head"><div><h1>Outlier index</h1><div class="sub">Your own outlier database: every morning TubeDesk spends spare YouTube quota searching your niches and keeps every video it sees. Searching it is free.</div></div>
      <div><button class="btn" id="crawl">Grow it now</button></div></div>
      <div class="tabs">${raw(tabs.map(([k, l]) => h`<a class="${k === tab ? 'active' : ''}" href="#/index?tab=${k}">${l}</a>`).join(''))}</div><div id="stats" class="mini" style="margin:8px 0"></div><div id="body"></div>`;
    main.querySelector('#crawl').onclick = async e => { busy(e.target, true); try { const r = await api('/index/crawl?wait=1', { method: 'POST', body: {} }); toast(r.skipped ? `Skipped: ${r.skipped}` : `${r.queries} searches, ${r.added} new videos (${r.units} units)`); TD.route(); } catch (x) { err(x); } busy(e.target, false); };
    api('/index/stats').then(s => { main.querySelector('#stats').textContent = `${fmtFull(s.videos)} videos from ${fmtFull(s.channels)} channels · ${fmtFull(s.outliers || 0)} outliers (3×+) · ${fmtFull(s.thumbs)} thumbnails · ${s.queries.length} topics${s.last ? ` · last grown ${ago(s.last.at)}` : ''}`; }).catch(() => {});
    const body = main.querySelector('#body');
    const search = (ph, extra = '') => h`<form id="f" class="row" style="gap:8px;margin-bottom:12px;flex-wrap:wrap"><input name="q" placeholder="${ph}" value="${q.q || ''}" style="flex:1;min-width:200px">${raw(extra)}<button class="btn primary">Search</button></form>`;
    const bind = () => { const f = body.querySelector('#f'); if (f) f.onsubmit = e => { e.preventDefault(); TD.go('/index', { tab, ...Object.fromEntries(new FormData(f)) }); }; };
    if (tab === 'outliers') {
      body.innerHTML = search('topic, e.g. "aging parents medicare"', h`<select name="format"><option value="all">All formats</option><option value="long" ${q.format === 'long' ? 'selected' : ''}>Long-form</option><option value="shorts" ${q.format === 'shorts' ? 'selected' : ''}>Shorts</option></select><select name="minX">${raw([2, 3, 5, 10].map(n => `<option value="${n}" ${String(q.minX || 3) === String(n) ? 'selected' : ''}>${n}×+</option>`).join(''))}</select>`) + '<div id="res" class="loading">Loading…</div>';
      bind();
      const r = await api(`/index?q=${encodeURIComponent(q.q || '')}&format=${q.format || 'all'}&minX=${q.minX || 3}&limit=60`);
      body.querySelector('#res').outerHTML = r.results.length ? h`<table class="table"><thead><tr><th></th><th>Video</th><th class="num">Views</th><th class="num">× channel avg</th></tr></thead><tbody>${raw(r.results.map(thumbRow).join(''))}</tbody></table><div class="src">${r.note}</div>`
        : empty(r.indexed ? 'No outliers for that search yet.' : 'The index is empty — it fills every morning, or press "Grow it now".');
    } else if (tab === 'niches') {
      body.innerHTML = search('optional topic', h`<select name="maxSubs">${raw([10000, 50000, 100000, 500000].map(n => `<option value="${n}" ${String(q.maxSubs || 100000) === String(n) ? 'selected' : ''}>≤ ${fmt(n)} subs</option>`).join(''))}</select>`) + '<div id="res" class="loading">Loading…</div>';
      bind();
      const r = await api(`/niches?q=${encodeURIComponent(q.q || '')}&maxSubs=${q.maxSubs || 100000}`);
      body.querySelector('#res').outerHTML = r.niches.length ? h`<table class="table"><thead><tr><th>Channel</th><th class="num">Subs</th><th class="num">Age</th><th class="num">Avg ×</th><th class="num">Top views</th><th>Sample titles</th></tr></thead><tbody>${raw(r.niches.map(n => h`<tr><td><a href="https://www.youtube.com/channel/${n.channelId}" target="_blank">${n.channel}</a></td><td class="num">${fmt(n.subscribers)}</td><td class="num">${n.channelAgeDays !== null ? Math.round(n.channelAgeDays / 30) + ' mo' : '—'}</td><td class="num"><b>${xfmt(n.avgX)}</b></td><td class="num">${fmt(n.topViews)}</td><td class="mini">${n.sampleTitles.join(' · ')}</td></tr>`).join(''))}</tbody></table><div class="src">Small or young channels whose videos beat their own average by a wide margin — topics with room for a newcomer.</div>` : empty('Nothing yet — niches appear as the index grows.');
    } else if (tab === 'formulas') {
      body.innerHTML = search('niche, e.g. "personal finance"', h`<select name="format"><option value="all">All formats</option><option value="long" ${q.format === 'long' ? 'selected' : ''}>Long-form</option><option value="shorts" ${q.format === 'shorts' ? 'selected' : ''}>Shorts</option></select>`) + '<div id="res" class="loading">Loading…</div>';
      bind();
      const r = await api(`/formulas?q=${encodeURIComponent(q.q || '')}&format=${q.format || 'all'}`);
      body.querySelector('#res').outerHTML = r.formulas.length ? h`<div class="grid g2">${raw(r.formulas.map(f => h`<div class="card"><h3 style="margin:0 0 6px">${f.formula}</h3><div class="mini">${f.uses} outliers · median ${xfmt(f.medianX)}</div>${raw(f.examples.map(e => h`<div class="mini" style="margin-top:6px">“${e.title}” — ${e.channel || ''} <b>${xfmt(e.x)}</b></div>`).join(''))}</div>`).join(''))}</div><div class="src">From ${fmtFull(r.sample)} outlier titles. ${r.note || ''}</div>` : empty(r.note || 'No recurring formulas yet for this topic.');
    } else {
      body.innerHTML = h`<form id="f" class="row" style="gap:8px;margin-bottom:12px;flex-wrap:wrap"><input name="videoId" placeholder="YouTube video id or URL" value="${q.videoId || ''}" style="flex:1;min-width:200px"><input name="file" placeholder="…or an image on this Mac (/Users/…/thumb.jpg)" value="${q.file || ''}" style="flex:1;min-width:200px"><button class="btn primary">Find similar</button></form><div id="res"></div>`;
      const f = body.querySelector('#f');
      f.onsubmit = e => { e.preventDefault(); const d = Object.fromEntries(new FormData(f)); d.videoId = (d.videoId.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [])[1] || d.videoId.trim(); TD.go('/index', { tab, ...d }); };
      if (q.videoId || q.file) {
        body.querySelector('#res').innerHTML = '<div class="loading">Comparing…</div>';
        try {
          const r = q.file ? await api('/thumbnails/similar', { method: 'POST', body: { file: q.file } }) : await api(`/thumbnails/similar?videoId=${encodeURIComponent(q.videoId)}`);
          body.querySelector('#res').innerHTML = r.results.length ? h`<table class="table"><thead><tr><th></th><th>Video</th><th class="num">Views</th><th class="num">×</th><th class="num">Match</th></tr></thead><tbody>${raw(r.results.map(thumbRow).join(''))}</tbody></table><div class="src">Compared with ${fmtFull(r.compared)} thumbnails. ${r.note || ''}</div>` : empty('No close matches yet.');
        } catch (e) { body.querySelector('#res').innerHTML = h`<div class="note bad">${e.message}</div>`; }
      }
    }
  });

  // ---------- Rank tracker ----------
  view('/ranks', async main => {
    const ch = state.current;
    main.innerHTML = h`<div class="page-head"><div><h1>Rank tracker</h1><div class="sub">Where your videos appear in YouTube search for your keywords, checked every morning (100 quota units per keyword).</div></div><div><button class="btn" id="check">Check now</button></div></div>
      <form id="add" class="row" style="gap:8px;margin-bottom:12px"><input name="keyword" placeholder="keyword to track" style="flex:1"><button class="btn primary">Track</button></form><div id="list" class="loading">Loading…</div>`;
    if (!ch) { main.querySelector('#list').outerHTML = needOwned(); return; }
    main.querySelector('#add').onsubmit = async e => { e.preventDefault(); const kw = new FormData(e.target).get('keyword'); try { await api('/ranks', { method: 'POST', body: { channelId: ch.id, keyword: kw } }); TD.route(); } catch (x) { err(x); } };
    main.querySelector('#check').onclick = async e => { busy(e.target, true); try { await api('/ranks/check', { method: 'POST', body: {} }); TD.route(); } catch (x) { err(x); } busy(e.target, false); };
    const r = await api(`/ranks?channelId=${encodeURIComponent(ch.id)}`);
    const spark = hist => { const pts = hist.filter(p => p.position); if (pts.length < 2) return ''; const W = 120, H = 28, max = 50; return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline fill="none" stroke="var(--info)" stroke-width="2" points="${hist.map((p, i) => `${(i / Math.max(1, hist.length - 1)) * W},${p.position ? ((p.position - 1) / max) * H : H}`).join(' ')}"/></svg>`; };
    main.querySelector('#list').outerHTML = r.keywords.length ? h`<table class="table"><thead><tr><th>Keyword</th><th class="num">Position</th><th class="num">7 days</th><th>Trend</th><th>Your video</th><th></th></tr></thead><tbody>${raw(r.keywords.map(k => h`<tr><td>${k.keyword}</td><td class="num"><b>${k.position ?? '50+'}</b></td><td class="num ${k.change7d > 0 ? 'up' : k.change7d < 0 ? 'down' : ''}">${k.change7d ? (k.change7d > 0 ? '▲' : '▼') + Math.abs(k.change7d) : '—'}</td><td>${raw(spark(k.history))}</td><td class="mini">${k.bestVideo || ''}</td><td><button class="btn small" data-del="${k.id}">Remove</button></td></tr>`).join(''))}</tbody></table><div class="src">${r.keywords[0].note}</div>` : empty('No keywords tracked yet.');
    main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api(`/ranks/${b.dataset.del}`, { method: 'DELETE' }); TD.route(); });
  });

  // ---------- Bulk editor ----------
  view('/bulk', async main => {
    const ch = state.current;
    main.innerHTML = h`<div class="page-head"><div><h1>Bulk editor</h1><div class="sub">Change titles, descriptions or tags on many videos at once. Preview first — nothing changes on YouTube until you apply, and every batch can be undone.</div></div></div><div id="b"></div>`;
    if (!ch) { main.querySelector('#b').innerHTML = needOwned(); return; }
    main.querySelector('#b').innerHTML = h`<form id="f" class="card"><div class="grid g3">
      <label>Videos whose title contains<input name="q" placeholder="(all)"></label>
      <label>Format<select name="format"><option value="all">All</option><option value="long">Long-form</option><option value="shorts">Shorts</option></select></label>
      <label>Published since<input name="since" type="date"></label></div>
      <div class="grid g3" style="margin-top:8px">
      <label>Field<select name="field"><option value="description">Description</option><option value="title">Title</option><option value="tags">Tags</option></select></label>
      <label>Action<select name="action"><option value="append">Append</option><option value="prepend">Prepend</option><option value="replace">Find & replace</option><option value="remove-line">Remove lines containing</option><option value="set">Set to</option><option value="add">Add tags</option><option value="remove">Remove tags</option></select></label>
      <label>Find (for replace / remove)<input name="find"></label></div>
      <label style="display:block;margin-top:8px">Value (for tags: comma-separated)<textarea name="value" rows="3"></textarea></label>
      <button class="btn primary" style="margin-top:10px">Preview</button></form><div id="prev"></div><h3 style="margin-top:18px">Recent batches</h3><div id="hist"></div>`;
    const hist = async () => { const r = await api(`/bulk?channelId=${encodeURIComponent(ch.id)}`); main.querySelector('#hist').innerHTML = r.batches.length ? h`<table class="table"><tbody>${raw(r.batches.map(b => h`<tr><td>#${b.id}</td><td>${b.status}${b.undo_of ? ` (undo of #${b.undo_of})` : ''}</td><td class="mini">${JSON.stringify(b.ops).slice(0, 90)}</td><td class="mini">${b.n} videos · ${ago(b.created_at + 'Z')}</td><td>${['applied', 'partial'].includes(b.status) && !b.undo_of ? h`<button class="btn small" data-undo="${b.id}">Undo</button>` : ''}</td></tr>`).join(''))}</tbody></table>` : '<div class="mini">None yet.</div>'; main.querySelectorAll('[data-undo]').forEach(x => x.onclick = async e => { busy(e.target, true); try { const r = await api(`/bulk/${x.dataset.undo}/undo`, { method: 'POST', body: {} }); toast(`Restored ${r.applied} video(s)`); hist(); } catch (y) { err(y); } busy(e.target, false); }); };
    hist();
    main.querySelector('#f').onsubmit = async e => {
      e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
      const op = { field: d.field, action: d.action, value: d.value, find: d.find || undefined };
      if (d.field === 'tags') op.values = d.value.split(',').map(s => s.trim()).filter(Boolean);
      try {
        const r = await api('/bulk/preview', { method: 'POST', body: { channelId: ch.id, q: d.q, format: d.format, since: d.since || null, ops: [op] } });
        main.querySelector('#prev').innerHTML = h`<div class="card" style="margin-top:12px"><b>${r.changes}</b> of ${r.matched} videos change · ${r.ready} ready${r.blocked ? `, ${r.blocked} blocked` : ''} · ${fmtFull(r.quotaUnits)} quota units
          ${r.ready ? h` <button class="btn primary" id="apply">Apply ${r.ready}</button>` : ''}
          <table class="table" style="margin-top:8px"><tbody>${raw(r.items.slice(0, 50).map(c => h`<tr><td class="mini">${c.videoId}</td><td>${raw(c.fields.map(f => h`<div class="mini"><b>${f}</b>: <span class="down">${String(JSON.stringify(c.before[f])).slice(0, 120)}</span> → <span class="up">${String(JSON.stringify(c.after[f])).slice(0, 160)}</span></div>`).join(''))}${c.problems.length ? h`<div class="note bad">${c.problems.join('; ')}</div>` : ''}</td></tr>`).join(''))}</tbody></table></div>`;
        const a = main.querySelector('#apply'); if (a) a.onclick = async () => { busy(a, true); try { const x = await api(`/bulk/${r.batchId}/apply`, { method: 'POST', body: {} }); toast(`Updated ${x.applied} video(s)${x.failed ? `, ${x.failed} failed` : ''}`); main.querySelector('#prev').innerHTML = ''; hist(); } catch (y) { err(y); } busy(a, false); };
      } catch (x) { err(x); }
    };
  });

  // ---------- Make a video ----------
  view('/make', async main => {
    const ch = state.current;
    main.innerHTML = h`<div class="page-head"><div><h1>Make a video</h1><div class="sub">Idea → script → your voice with captions → render → cover → (optionally) scheduled at your best slot on YouTube and this brand's Instagram/TikTok.</div></div></div><div id="b"></div>`;
    if (!ch) { main.querySelector('#b').innerHTML = needOwned(); return; }
    main.querySelector('#b').innerHTML = h`<form id="f" class="card"><label>Topic<input name="topic" placeholder="e.g. the Medicare enrollment mistake that costs families thousands"></label>
      <label style="display:block;margin-top:8px">Or your own script (optional)<textarea name="script" rows="4"></textarea></label>
      <div class="grid g3" style="margin-top:8px"><label>Background<input name="background" placeholder="blank = branded card · 'ai' · /path/to/clip.mp4"></label>
      <label>Voice<select name="voiceProvider"><option value="">Default</option><option value="heygen">HeyGen (your clone)</option><option value="elevenlabs">ElevenLabs</option></select></label>
      <label>When done<select name="publish"><option value="review">Just make the file</option><option value="schedule">Schedule at the best slot</option></select></label></div>
      <button class="btn primary" style="margin-top:10px">Make it</button></form><div id="out"></div>`;
    main.querySelector('#f').onsubmit = async e => {
      e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); const btn = e.target.querySelector('button'); busy(btn, true);
      const out = main.querySelector('#out'); out.innerHTML = '<div class="loading">Writing, recording and rendering — a few minutes…</div>';
      try {
        const r = await api('/make-video?wait=1', { method: 'POST', body: { channelId: ch.id, topic: d.topic, script: d.script || null, background: d.background || null, voiceProvider: d.voiceProvider || null, publish: d.publish } });
        const res = r.result || r;
        out.innerHTML = h`<div class="card" style="margin-top:12px"><h3>${res.title}</h3><video src="/data/made/${res.file.split('/').pop()}" controls style="max-width:320px;border-radius:10px"></video>
          <div class="mini" style="margin-top:6px">${res.file}</div>${res.scheduled ? h`<div class="note">Scheduled for ${new Date(res.scheduled.publishAt).toLocaleString()} — YouTube ${res.scheduled.youtube ? '✓' : '—'}, Instagram ${res.scheduled.instagram || '—'}, TikTok ${res.scheduled.tiktok || '—'}</div>` : ''}
          ${res.scores ? h`<div class="mini" style="margin-top:8px">Radar: ${raw(res.scores.map(s => h`${s.title} <b>${s.score ?? '—'}</b>`).join(' · '))}</div>` : ''}<details style="margin-top:8px"><summary>Script</summary><p>${res.script}</p></details></div>`;
      } catch (x) { out.innerHTML = h`<div class="note bad">${x.message}</div>`; }
      busy(btn, false);
    };
  });

  // ---------- Health ----------
  view('/health', async main => {
    main.innerHTML = h`<div class="page-head"><div><h1>Health</h1><div class="sub">Everything that could quietly stop TubeDesk working — checked every morning; problems are texted to you once a day.</div></div><div><button class="btn" id="backup">Back up now</button> <button class="btn" id="upd">Check for updates</button></div></div><div id="b" class="loading">Checking…</div>`;
    const [r, bk, up, ph] = await Promise.all([api('/health'), api('/backups'), api('/update'), api('/phone').catch(() => null)]);
    const icon = l => ({ ok: '<span class="up">●</span>', warn: '<span style="color:var(--warn)">●</span>', error: '<span class="down">●</span>' }[l]);
    main.querySelector('#b').outerHTML = h`<div class="grid g3" style="margin-bottom:12px">${raw(stat('Status', r.status.toUpperCase()))}${raw(stat('Problems', r.errors))}${raw(stat('Warnings', r.warnings))}</div>
      <div class="card"><table class="table"><tbody>${raw(r.items.map(i => h`<tr><td style="width:18px">${raw(icon(i.level))}</td><td><b>${i.title}</b><div class="mini">${i.detail}</div>${i.fix ? h`<div class="mini" style="color:var(--fg)">→ ${i.fix}</div>` : ''}</td></tr>`).join(''))}</tbody></table></div>
      ${ph && ph.state ? h`<div class="card" style="margin-top:12px"><h3>On your phone</h3>${ph.state === 'on' ? h`<div>Open <a href="${ph.url}" target="_blank">${ph.url}</a> on your phone (Tailscale app signed in with ${ph.owner || 'your account'}), then Share → Add to Home Screen.</div>` : h`<div class="mini">${ph.state === 'not-installed' || ph.state === 'signed-out' ? 'Needs Tailscale signed in on this Mac.' : ph.state === 'port-in-use' ? 'Port 8443 is used by something else in Tailscale Serve.' : 'Off.'}</div>`}</div>` : ''}
      <div class="card" style="margin-top:12px"><h3>Scheduled jobs</h3><table class="table"><thead><tr><th>Job</th><th>Schedule</th><th>Last OK</th><th>Last error</th><th></th></tr></thead><tbody>${raw(r.jobs.map(j => h`<tr><td>${j.label}</td><td class="mini">${j.schedule}</td><td class="mini">${j.lastOk ? ago(j.lastOk) : '—'}</td><td class="mini ${j.lastError ? 'down' : ''}">${j.lastError || ''}</td><td><button class="btn small" data-run="${j.name}">Run</button></td></tr>`).join(''))}</tbody></table></div>
      <div class="card" style="margin-top:12px"><h3>Backups</h3><div class="mini">${bk.dir}</div><table class="table"><tbody>${raw(bk.backups.map(b => h`<tr><td>${b.file}</td><td class="mini">${(b.bytes / 1e6).toFixed(1)} MB</td><td><button class="btn small" data-restore="${b.file}">Restore</button></td></tr>`).join('') || '<tr><td class="mini">None yet — one is made every night.</td></tr>')}</tbody></table></div>
      <div class="card" style="margin-top:12px"><h3>Updates</h3><div class="mini">Automatic updates: ${up.auto ? 'on' : 'off'} · ${up.status ? (up.status.behind ? `${up.status.behind} update(s) waiting` : `up to date (v${up.status.version})`) : 'not checked yet'}${up.last ? ` · last update ${ago(up.last.at)} to v${up.last.version}` : ''}</div></div>`;
    main.querySelectorAll('[data-run]').forEach(b => b.onclick = async () => { busy(b, true); try { await api(`/jobs/${b.dataset.run}/run?wait=1`, { method: 'POST', body: {} }); toast('Done'); } catch (x) { err(x); } TD.route(); });
    main.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => { if (!confirm(`Restore ${b.dataset.restore}? TubeDesk restarts with that data (the current data is kept as a backup).`)) return; try { const x = await api('/backups/restore', { method: 'POST', body: { file: b.dataset.restore } }); toast(x.note); } catch (y) { err(y); } });
    main.querySelector('#backup').onclick = async e => { busy(e.target, true); try { const x = await api('/backups', { method: 'POST', body: {} }); toast(`Saved ${x.created}`); TD.route(); } catch (y) { err(y); } busy(e.target, false); };
    main.querySelector('#upd').onclick = async e => { busy(e.target, true); try { const x = await api('/update?check=1'); toast(x.status?.behind ? `${x.status.behind} update(s) — installs tonight` : 'Up to date'); } catch (y) { err(y); } busy(e.target, false); };
  });
})();
