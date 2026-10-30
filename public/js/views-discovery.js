/* Keywords, outliers, trending & niches, boards & blueprints */
(() => {
  const { view, api, h, raw, esc, fmt, fmtFull, pct, ago, date, videoCell, stat, empty, hbars, lineChart, err, toast, busy, state, openVideo, scoreRing, copy, downloadText, csvFrom } = TD;
  const country = () => state.status?.country || 'US';

  // ---------- Keywords ----------
  view('/keywords', async (main, r) => {
    const q = r.query.q || '';
    main.innerHTML = h`<div class="page-head"><div><h1>Keyword research</h1><div class="sub">Autocomplete tree (free, no quota) + competition evidence from a real search sample (≈102 quota units per keyword, cached 24h).</div></div></div>
      <div class="card tight row" style="margin-bottom:12px"><input id="q" placeholder="Seed keyword, e.g. medicaid for parents" value="${q}" style="flex:1;min-width:240px"><input id="country" value="${r.query.country || 'US'}" style="width:60px" title="country code"><button id="explore" class="primary">Explore</button><button id="compete">Competition evidence</button><button id="rising">Rising check</button></div><div id="out">${q ? '' : h`<div class="empty">Start with a seed term. Tip: Analytics → Traffic shows the real search terms that already bring you views.</div>`}</div>`;
    const out = main.querySelector('#out');
    const getQ = () => main.querySelector('#q').value.trim();
    const run = async (kind) => {
      const kw = getQ(); if (!kw) return;
      const c = main.querySelector('#country').value.trim() || 'US';
      out.innerHTML = h`<div class="loading"><span class="spinner"></span> Working…</div>`;
      try {
        if (kind === 'explore') {
          const [d, dm] = await Promise.all([api(`/keywords/explore?q=${encodeURIComponent(kw)}&country=${c}`), api(`/keywords/demand?q=${encodeURIComponent(kw)}&country=${c}`).catch(() => null)]);
          const pill = k => h`<span class="pill" data-kw="${k.keyword || k}">${k.keyword || k}</span>`;
          out.innerHTML = h`${dm ? h`<div class="card" style="margin-bottom:12px"><div class="row" style="gap:18px;align-items:center"><div class="score ${TD.scoreClass(dm.demandIndex)}" style="width:64px;height:64px;font-size:22px">${dm.demandIndex}</div><div style="flex:1;min-width:200px"><h2 style="margin:0">Demand index · ${dm.band}</h2><div class="mini">Autocompletes in ${dm.regionsPresent.join(', ') || 'no'} region(s)${dm.homeRank ? `, rank #${dm.homeRank} in ${dm.country}` : ''}</div></div><div class="grid g4" style="flex:2;min-width:280px">${raw(Object.entries(dm.components).map(([k, v]) => h`<div><div class="mini">${k}</div><div class="progress"><i style="width:${v}%"></i></div><div class="mini">${v}</div></div>`))}</div></div><div class="src">${dm.note}</div></div>` : ''}<div class="grid g3"><div class="card"><h2>Autocomplete (${d.autocomplete.length})</h2><div class="pill-list">${raw(d.autocomplete.map(pill).join('') || h`<span class="muted">none — Google suggest may be blocked on this network</span>`)}</div></div>
            <div class="card"><h2>Questions (${d.questions.length})</h2><div class="pill-list">${raw(d.questions.map(pill).join('') || h`<span class="muted">none</span>`)}</div></div>
            <div class="card"><h2>Long-tail (${d.longTail.length})</h2><div class="pill-list">${raw(d.longTail.slice(0, 80).map(pill).join('') || h`<span class="muted">none</span>`)}</div></div></div>
            <div class="card" style="margin-top:12px"><h2>Modifier ideas</h2><div class="pill-list">${raw(d.modifiers.map(pill).join(''))}</div><div class="src">${d.source}. Click any term to make it the seed; use "Competition evidence" to pull a real search sample for it.</div></div>`;
        } else if (kind === 'compete') {
          const d = await api(`/keywords/competition?q=${encodeURIComponent(kw)}&country=${c}`);
          const hist = await api(`/keywords/history?q=${encodeURIComponent(kw)}&country=${c}`);
          out.innerHTML = h`<div class="grid g4">${raw(stat('Opportunity score', scoreRing(d.opportunityScore), h`<span class="muted">higher = more room</span>`))}${raw(stat('Median views (top results)', fmt(d.medianViews)))}${raw(stat('Median channel size', fmt(d.medianChannelSubs) + ' subs'))}${raw(stat('Results < 90 days old', pct(d.recentShare, 0)))}</div>
            <div class="grid g2" style="margin-top:12px"><div class="card"><h2>How the score is built</h2>${raw(hbars(Object.entries(d.components).map(([k, v]) => ({ label: k, value: v })), { max: 100, format: x => x + '/100' }))}<div class="src">${d.formula}. Small-channel share: ${pct(d.smallChannelShare, 0)} of the top ${d.sampleSize} are channels under 50K subs. Exact-title match share: ${pct(d.exactTitleShare, 0)}. YouTube reports ~${fmtFull(d.totalResultsReported)} results (an estimate).</div></div>
            <div class="card"><h2>Score history</h2>${raw(hist.length > 1 ? lineChart([{ values: hist.map(x => x.score) }], { labels: hist.map(x => x.day), format: x => x.toFixed(0) }) : h`<div class="muted">Run this keyword on other days to see the trend.</div>`)}</div></div>
            <div class="card" style="margin-top:12px"><h2>Top results sample <button class="sm" id="csv">CSV</button></h2>${raw(state.views.resultTable(d.results, { extra: v => h`<button class="sm" data-board='${(JSON.stringify({ id: v.id, title: v.title, thumbnail: v.thumbnail, channel_title: v.channel_title, view_count: v.view_count }))}'>Save</button>` }))}<div class="src">${d.source}</div></div>`;
          out.querySelector('#csv').onclick = () => downloadText(`keyword-${kw}.csv`, csvFrom(d.results.map(v => ({ id: v.id, title: v.title, channel: v.channel_title, channel_subs: v.channel_subs, views: v.view_count, age_days: v.age_days, exact_in_title: v.exact_in_title }))));
        } else {
          const d = await api(`/keywords/rising?q=${encodeURIComponent(kw)}&country=${c}`);
          out.innerHTML = h`<div class="grid g2"><div class="card"><h2>New since ${d.comparedTo || 'first check'} (${d.newSuggestions.length})</h2><div class="pill-list">${raw(d.newSuggestions.map(k => h`<span class="pill on" data-kw="${k}">${k}</span>`).join('') || h`<span class="muted">none</span>`)}</div></div><div class="card"><h2>Dropped (${d.droppedSuggestions.length})</h2><div class="pill-list">${raw(d.droppedSuggestions.map(k => h`<span class="pill" data-kw="${k}">${k}</span>`).join('') || h`<span class="muted">none</span>`)}</div></div></div><div class="note" style="margin-top:12px">${d.note}</div>`;
        }
        out.querySelectorAll('[data-kw]').forEach(p => p.onclick = () => { main.querySelector('#q').value = p.dataset.kw; run('explore'); });
        out.querySelectorAll('.vlink').forEach(a => a.onclick = e => { e.preventDefault(); openVideo(a.dataset.v); });
        out.querySelectorAll('[data-board]').forEach(b => b.onclick = () => state.views.saveToBoard('video', JSON.parse(b.dataset.board), `keyword: ${kw}`));
      } catch (e) { out.innerHTML = h`<div class="note bad">${(e.message)}</div>`; }
    };
    main.querySelector('#explore').onclick = () => run('explore');
    main.querySelector('#compete').onclick = () => run('compete');
    main.querySelector('#rising').onclick = () => run('rising');
    main.querySelector('#q').onkeydown = e => { if (e.key === 'Enter') run('explore'); };
    if (q) run(r.query.mode || 'explore');
  });

  // ---------- Outliers ----------
  view('/outliers', async (main, r) => {
    const ch = state.current;
    const comps = ch ? await api(`/competitors/${ch.id}`) : [];
    main.innerHTML = h`<div class="page-head"><div><h1>Outliers</h1><div class="sub">Videos performing far above their channel's own median. "Library" uses synced data (no quota); "Search" samples YouTube (100+ units).</div></div></div>
      <div class="tabs"><a href="#/outliers" class="${!r.query.mode ? 'active' : ''}">Library (own + competitors)</a><a href="#/outliers?mode=search" class="${r.query.mode === 'search' ? 'active' : ''}">Search any topic</a></div>
      ${!r.query.mode ? h`<div class="card tight row" style="margin-bottom:12px"><select id="format"><option value="long">Long-form</option><option value="shorts">Shorts</option><option value="all">All</option></select><label class="f" style="flex-direction:row;align-items:center;gap:6px">min ×<input id="minx" type="number" value="2" step="0.5" style="width:70px"></label><label class="f" style="flex-direction:row;align-items:center;gap:6px">within days<input id="days" type="number" value="365" style="width:80px"></label><div class="pill-list" id="chs">${ch ? h`<span class="pill on" data-id="${ch.id}">${ch.title}</span>` : ''}${comps.map(c => h`<span class="pill on" data-id="${c.id}">${c.title}</span>`).join('')}</div><button id="go" class="primary">Find</button></div>`
      : h`<div class="card tight row" style="margin-bottom:12px"><input id="q" placeholder="Topic, e.g. aging parents finances" value="${r.query.q || ''}" style="flex:1;min-width:220px"><select id="sdays"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="365">1 year</option><option value="3650">all time</option></select><select id="sformat"><option value="all">Any</option><option value="long">Long-form</option><option value="shorts">Shorts</option></select><input id="maxsubs" type="number" placeholder="max subs" style="width:110px"><select id="order"><option value="viewCount">by views</option><option value="date">newest</option><option value="relevance">relevance</option></select><button id="go" class="primary">Search</button></div>`}
      <div id="out">${empty(ch ? 'Choose channels and click Find.' : 'Add an owned channel to use library outliers, or search any topic.')}</div>`;
    const out = main.querySelector('#out');
    main.querySelectorAll('#chs .pill').forEach(p => p.onclick = () => p.classList.toggle('on'));
    main.querySelector('#go').onclick = async e => {
      busy(e.target, true); out.innerHTML = h`<div class="loading"><span class="spinner"></span></div>`;
      try {
        let rows, note;
        if (!r.query.mode) {
          const ids = [...main.querySelectorAll('#chs .pill.on')].map(p => p.dataset.id);
          rows = await api(`/outliers/local?channels=${ids.join(',')}&format=${main.querySelector('#format').value}&minX=${main.querySelector('#minx').value}&days=${main.querySelector('#days').value}`);
          note = 'outlier × = views ÷ median views of the same channel & format (sample size shown). velocity × = views-per-day vs channel median.';
          out.innerHTML = rows.length ? h`<div class="card"><table><thead><tr><th>Video</th><th class="num">Views</th><th class="num">Outlier ×</th><th class="num">Velocity ×</th><th class="num">Sample</th><th></th></tr></thead><tbody>${rows.map(v => h`<tr><td><a href="#" class="vlink" data-v="${v.id}">${raw(videoCell(v, { showChannel: true }))}</a></td><td class="num">${fmtFull(v.view_count)}</td><td class="num"><span class="badge x ok">${v.outlier_x.toFixed(1)}×</span></td><td class="num">${v.velocity_x.toFixed(1)}×</td><td class="num">${v.sample}</td><td><button class="sm" data-board='${(JSON.stringify({ id: v.id, title: v.title, thumbnail: v.thumbnail, channel_title: v.channel_title, view_count: v.view_count }))}'>Save</button></td></tr>`).join('')}</tbody></table><div class="src">${note}</div></div>` : empty('No outliers above the threshold. Lower the minimum × or sync more videos.');
        } else {
          const q = main.querySelector('#q').value.trim(); if (!q) { busy(e.target, false); return; }
          const d = await api(`/outliers/search?q=${encodeURIComponent(q)}&days=${main.querySelector('#sdays').value}&format=${main.querySelector('#sformat').value}&maxSubs=${main.querySelector('#maxsubs').value}&order=${main.querySelector('#order').value}`);
          out.innerHTML = h`<div class="card"><h2>${(q)} · ${d.sampleSize} results</h2><table><thead><tr><th>Video</th><th class="num">Views</th><th class="num">Views/day</th><th class="num">Ch. subs</th><th class="num">Views ÷ subs</th><th class="num">Breakout</th><th></th></tr></thead><tbody>${d.results.map(v => h`<tr><td><a href="#" class="vlink" data-v="${v.id}">${raw(videoCell(v, { showChannel: true }))}</a></td><td class="num">${fmtFull(v.view_count)}</td><td class="num">${fmt(v.vpd)}</td><td class="num">${fmt(v.channel_subs)}</td><td class="num">${v.subs_ratio.toFixed(1)}×</td><td class="num"><span class="badge x ${v.breakout_score >= 60 ? 'ok' : ''}">${v.breakout_score}</span></td><td class="row"><button class="sm" data-board='${(JSON.stringify({ id: v.id, title: v.title, thumbnail: v.thumbnail, channel_title: v.channel_title, view_count: v.view_count }))}'>Save</button><button class="sm ghost" data-comp="${v.channel_id}">+ competitor</button></td></tr>`).join('')}</tbody></table><div class="src">${d.source}</div></div>`;
        }
        out.querySelectorAll('.vlink').forEach(a => a.onclick = ev => { ev.preventDefault(); openVideo(a.dataset.v); });
        out.querySelectorAll('[data-board]').forEach(b => b.onclick = () => state.views.saveToBoard('video', JSON.parse(b.dataset.board)));
        out.querySelectorAll('[data-comp]').forEach(b => b.onclick = async () => { if (!ch) return toast('Select an owned channel'); busy(b, true); try { const c = await api(`/competitors/${ch.id}`, { method: 'POST', body: { input: b.dataset.comp } }); toast(`Tracking ${c.title}`, 'ok'); } catch (x) { err(x); } busy(b, false); });
      } catch (x) { out.innerHTML = h`<div class="note bad">${(x.message)}</div>`; }
      busy(e.target, false);
    };
    if (r.query.q) main.querySelector('#go').click();
  });

  // ---------- Trending & niches ----------
  view('/trending', async (main, r) => {
    const tab = r.query.tab || 'trending';
    main.innerHTML = h`<div class="page-head"><div><h1>Trending & niches</h1><div class="sub">Trending: YouTube's mostPopular chart by region and category. Niches: channels found for a topic, sized by views per video.</div></div></div>
      <div class="tabs"><a href="#/trending" class="${tab === 'trending' ? 'active' : ''}">Trending videos</a><a href="#/trending?tab=niche" class="${tab === 'niche' ? 'active' : ''}">Niche explorer</a><a href="#/trending?tab=patterns" class="${tab === 'patterns' ? 'active' : ''}">Title patterns</a></div><div id="body"></div>`;
    const body = main.querySelector('#body');
    if (tab === 'trending') {
      const cats = await api('/categories').catch(() => []);
      body.innerHTML = h`<div class="card tight row" style="margin-bottom:12px"><input id="country" value="US" style="width:60px"><select id="cat"><option value="">All categories</option>${cats.map(c => h`<option value="${c.id}">${c.title}</option>`).join('')}</select><button id="go" class="primary">Load</button></div><div id="out"></div>`;
      const load = async () => { const out = body.querySelector('#out'); out.innerHTML = h`<div class="loading"><span class="spinner"></span></div>`; try { const rows = await api(`/trending?country=${body.querySelector('#country').value}&category=${body.querySelector('#cat').value}`); out.innerHTML = h`<div class="card"><table><thead><tr><th>#</th><th>Video</th><th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th><th></th></tr></thead><tbody>${rows.map((v, i) => h`<tr><td class="rank">${i + 1}</td><td><a href="#" class="vlink" data-v="${v.id}">${raw(videoCell(v, { showChannel: true }))}</a></td><td class="num">${fmtFull(v.view_count)}</td><td class="num">${fmt(v.like_count)}</td><td class="num">${fmt(v.comment_count)}</td><td><button class="sm" data-board='${(JSON.stringify({ id: v.id, title: v.title, thumbnail: v.thumbnail, channel_title: v.channel_title, view_count: v.view_count }))}'>Save</button></td></tr>`).join('')}</tbody></table><div class="src">videos.list chart=mostPopular (1 quota unit), cached 3h.</div></div>`; out.querySelectorAll('.vlink').forEach(a => a.onclick = e => { e.preventDefault(); openVideo(a.dataset.v); }); out.querySelectorAll('[data-board]').forEach(b => b.onclick = () => state.views.saveToBoard('video', JSON.parse(b.dataset.board))); } catch (e) { out.innerHTML = h`<div class="note bad">${(e.message)}</div>`; } };
      body.querySelector('#go').onclick = load; load();
    } else if (tab === 'niche') {
      body.innerHTML = h`<div class="card tight row" style="margin-bottom:12px"><input id="q" placeholder="Niche, e.g. caregiving for aging parents" style="flex:1;min-width:240px"><button id="go" class="primary">Find channels (100 units)</button></div><div id="out"></div>`;
      body.querySelector('#go').onclick = async e => { const q = body.querySelector('#q').value.trim(); if (!q) return; busy(e.target, true); const out = body.querySelector('#out'); try { const rows = await api(`/niche/channels?q=${encodeURIComponent(q)}`); out.innerHTML = h`<div class="card"><table><thead><tr><th>Channel</th><th class="num">Subs</th><th class="num">Total views</th><th class="num">Videos</th><th class="num">Views / video</th><th class="num">Age</th><th></th></tr></thead><tbody>${rows.map(c => h`<tr><td><div class="vt"><img class="avatar" src="${c.thumbnail || ''}"><div><div class="t">${c.title}</div><div class="m">${c.handle || c.id}</div></div></div></td><td class="num">${fmtFull(c.subscriber_count)}</td><td class="num">${fmt(c.view_count)}</td><td class="num">${fmtFull(c.video_count)}</td><td class="num">${fmt(c.views_per_video)}</td><td class="num">${(c.age_days / 365).toFixed(1)}y</td><td class="row"><button class="sm" data-comp="${c.id}">+ competitor</button><a class="btn sm" href="https://youtube.com/channel/${c.id}" target="_blank">↗</a></td></tr>`).join('')}</tbody></table></div>`; out.querySelectorAll('[data-comp]').forEach(b => b.onclick = async () => { if (!state.current) return toast('Select an owned channel'); busy(b, true); try { const c = await api(`/competitors/${state.current.id}`, { method: 'POST', body: { input: b.dataset.comp } }); toast(`Tracking ${c.title}`, 'ok'); } catch (x) { err(x); } busy(b, false); }); } catch (x) { out.innerHTML = h`<div class="note bad">${(x.message)}</div>`; } busy(e.target, false); };
    } else {
      body.innerHTML = h`<div class="card"><h2>Title structure analysis</h2><p class="mini">Paste titles (one per line) — e.g. from a competitor's library, a keyword sample, or your own — to see which structures recur. Returns patterns, never the titles themselves, so you borrow structure rather than expression.</p><textarea id="titles" style="min-height:160px"></textarea><div class="row" style="margin-top:8px"><button id="go" class="primary">Analyze</button><button id="mine" class="sm">Load my titles</button></div><div id="out" style="margin-top:12px"></div></div>`;
      body.querySelector('#mine').onclick = async () => { if (!state.current) return; const d = await api(`/channels/${state.current.id}/videos?limit=300`); body.querySelector('#titles').value = d.videos.map(v => v.title).join('\n'); };
      body.querySelector('#go').onclick = async () => { const titles = body.querySelector('#titles').value.split('\n').map(s => s.trim()).filter(Boolean); const p = await api('/titles/patterns', { method: 'POST', body: { titles } }); body.querySelector('#out').innerHTML = h`<div class="grid g2">${raw(stat('Titles', p.sample))}${raw(stat('Median length', p.medianLength + ' chars / ' + p.medianWords + ' words'))}</div><div style="margin-top:12px">${hbars(p.patterns.filter(x => x.count), { label: x => x.pattern, value: x => x.share, format: x => pct(x, 0) })}</div>`; };
    }
  });

  // ---------- Boards & blueprints ----------
  view('/boards', async (main, r) => {
    const ch = state.current; if (!ch) { main.innerHTML = h`<h1>Boards & blueprints</h1>${TD.needOwned()}`; return; }
    const tab = r.query.tab || 'boards';
    main.innerHTML = h`<div class="page-head"><div><h1>Boards & blueprints</h1><div class="sub">Boards hold references (videos, keywords, titles, notes). Blueprints are one record per idea: idea → audience → titles → thumbnail → proof → outline.</div></div></div>
      <div class="tabs"><a href="#/boards" class="${tab === 'boards' ? 'active' : ''}">Boards</a><a href="#/boards?tab=blueprints" class="${tab === 'blueprints' ? 'active' : ''}">Blueprints</a><a href="#/boards?tab=saved" class="${tab === 'saved' ? 'active' : ''}">Saved AI outputs</a></div><div id="body"></div>`;
    const body = main.querySelector('#body');
    if (tab === 'boards') {
      const boards = await api(`/boards/${ch.id}`);
      const sel = Number(r.query.b || boards[0]?.id || 0);
      const items = sel ? await api(`/boards/id/${sel}/items`) : [];
      body.innerHTML = h`<div class="row" style="margin-bottom:12px">${boards.map(b => h`<a class="pill ${b.id === sel ? 'on' : ''}" href="#/boards?b=${b.id}">${b.name} (${b.items})</a>`).join('')}<button class="sm" id="newb">+ New board</button>${sel ? h`<button class="sm ghost" id="delb">Delete board</button>` : ''}</div>
        ${sel ? h`<div class="card"><div class="row" style="margin-bottom:10px"><input id="note-text" placeholder="Add a note, title idea or keyword…" style="flex:1"><select id="note-kind"><option value="note">note</option><option value="title">title idea</option><option value="keyword">keyword</option></select><button id="addn" class="sm">Add</button></div>
          ${items.length ? items.map(i => h`<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)"><div style="flex:1;min-width:0">${i.kind === 'video' ? raw(h`<a href="#" class="vlink" data-v="${(i.ref.id)}">${videoCell(i.ref, { showChannel: true })}</a>`) : i.kind === 'channel' ? h`<b>${i.ref.title}</b> <span class="mini">${fmt(i.ref.subscriber_count)} subs</span>` : h`<span class="badge">${i.kind}</span> ${i.ref.text || i.ref.title || JSON.stringify(i.ref)}`}${i.note ? h`<div class="mini">${i.note}</div>` : ''}</div><div class="row"><button class="sm ghost" data-note="${i.id}">note</button><button class="sm ghost" data-del="${i.id}">✕</button></div></div>`).join('') : h`<div class="muted">Empty. Save videos from Outliers, Keywords, Trending or any video drawer.</div>`}</div>` : TD.empty('Create a board to start collecting.')}`;
      body.querySelector('#newb').onclick = async () => { const name = prompt('Board name'); if (name) { await api(`/boards/${ch.id}`, { method: 'POST', body: { name } }); TD.route(); } };
      const db = body.querySelector('#delb'); if (db) db.onclick = async () => { if (confirm('Delete this board and its items?')) { await api(`/boards/id/${sel}`, { method: 'DELETE' }); TD.go('/boards'); } };
      const an = body.querySelector('#addn'); if (an) an.onclick = async () => { const text = body.querySelector('#note-text').value.trim(); if (!text) return; await api(`/boards/id/${sel}/items`, { method: 'POST', body: { kind: body.querySelector('#note-kind').value, ref: { text } } }); TD.route(); };
      body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api(`/boards/items/${b.dataset.del}`, { method: 'DELETE' }); TD.route(); });
      body.querySelectorAll('[data-note]').forEach(b => b.onclick = async () => { const note = prompt('Note'); if (note !== null) { await api(`/boards/items/${b.dataset.note}`, { method: 'PUT', body: { note } }); TD.route(); } });
      body.querySelectorAll('.vlink').forEach(a => a.onclick = e => { e.preventDefault(); openVideo(a.dataset.v); });
    } else if (tab === 'blueprints') {
      const bps = await api(`/blueprints/${ch.id}`);
      const STATUSES = ['idea', 'scripted', 'produced', 'published'];
      body.innerHTML = h`<div class="row" style="margin-bottom:12px"><button id="newbp" class="primary sm">+ New blueprint</button></div><div class="grid g2">${bps.map(b => h`<div class="card"><div class="row between"><h2 style="margin:0">${b.title}</h2><select data-st="${b.id}">${STATUSES.map(s => h`<option ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div><div class="kv" style="margin-top:8px"><b>Idea</b><span>${b.idea || '—'}</span><b>Audience</b><span>${b.audience || '—'}</span><b>Titles</b><span>${b.titles.join(' · ') || '—'}</span><b>Thumbnail</b><span>${b.thumbnail_notes || '—'}</span><b>Proof</b><span>${b.proof || '—'}</span></div>${b.outline ? h`<details style="margin-top:8px"><summary>Outline</summary><div class="pre">${b.outline}</div></details>` : ''}<div class="row" style="margin-top:10px"><button class="sm" data-edit="${b.id}">Edit</button><a class="btn sm" href="#/production?title=${encodeURIComponent(b.titles[0] || b.title)}&outline=${encodeURIComponent(b.outline || b.idea || '')}">Write script</a><button class="sm ghost" data-del="${b.id}">Delete</button></div></div>`).join('') || TD.empty('No blueprints yet.')}</div>`;
      const form = (b = {}) => { const title = prompt('Working title', b.title || ''); if (title === null) return null; return { title, idea: prompt('Idea / premise', b.idea || '') ?? b.idea, audience: prompt('Audience', b.audience || '') ?? b.audience, titles: (prompt('Title options (separate with |)', (b.titles || []).join(' | ')) ?? '').split('|').map(s => s.trim()).filter(Boolean), thumbnail_notes: prompt('Thumbnail concept', b.thumbnail_notes || '') ?? b.thumbnail_notes, proof: prompt('Proof / evidence of demand', b.proof || '') ?? b.proof }; };
      body.querySelector('#newbp').onclick = async () => { const d = form(); if (d) { await api(`/blueprints/${ch.id}`, { method: 'POST', body: d }); TD.route(); } };
      body.querySelectorAll('[data-edit]').forEach(b => b.onclick = async () => { const cur = bps.find(x => x.id === Number(b.dataset.edit)); const d = form(cur); if (d) { await api(`/blueprints/id/${cur.id}`, { method: 'PUT', body: d }); TD.route(); } });
      body.querySelectorAll('[data-st]').forEach(s => s.onchange = async () => { await api(`/blueprints/id/${s.dataset.st}`, { method: 'PUT', body: { status: s.value } }); toast('Status updated'); });
      body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (confirm('Delete blueprint?')) { await api(`/blueprints/id/${b.dataset.del}`, { method: 'DELETE' }); TD.route(); } });
    } else {
      const items = await api(`/saved/${ch.id}`);
      body.innerHTML = items.length ? items.map(i => { let bodyTxt = i.body; try { const j = JSON.parse(i.body); bodyTxt = JSON.stringify(j, null, 2); } catch {} return h`<div class="card" style="margin-bottom:12px"><div class="row between"><h2 style="margin:0"><span class="badge">${i.kind}</span> ${i.title}</h2><div class="row"><span class="mini">${date(i.created_at)}</span><button class="sm ghost" data-del="${i.id}">✕</button></div></div><details style="margin-top:8px"><summary>Show</summary><div class="pre ${i.kind === 'plan' ? 'mono' : ''}">${raw(i.kind === 'plan' ? esc(bodyTxt) : TD.mdLite(bodyTxt))}</div></details></div>`; }).join('') : TD.empty('Audits, weekly plans and other AI outputs you save appear here.');
      body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api(`/saved/id/${b.dataset.del}`, { method: 'DELETE' }); TD.route(); });
    }
  });
})();
