/* Video library + video detail drawer (shared) */
(() => {
  const { view, api, h, raw, esc, fmt, fmtFull, pct, ago, dur, date, videoCell, stat, empty, needOwned, lineChart, err, toast, busy, state, openDrawer, closeDrawer, checks, scoreRing, ytUrl, downloadText, csvFrom, copy, ls } = TD;

  async function openVideo(id) {
    openDrawer(h`<div class="loading"><span class="spinner"></span> Loading video…</div>`);
    try {
      const v = await api(`/videos/${id}`);
      const owned = state.channels.find(c => c.id === v.channel_id && c.kind === 'owned');
      const chk = owned ? await api(`/videos/${id}/checklist`).catch(() => null) : null;
      const age = owned ? await api(`/videos/${id}/age-comparison`).catch(() => null) : null;
      const html = h`
        <div class="drawer-head"><div><h2 style="font-size:17px">${v.title}</h2><div class="mini">${v.channel_title || ''} · published ${date(v.published_at)} · ${dur(v.duration_sec)} · ${v.is_short ? 'Short' : 'Long-form'} · ${v.format || ''} · <a href="${ytUrl(v.id)}" target="_blank">open on YouTube ↗</a></div></div><button class="sm" id="dr-close">✕</button></div>
        <div class="row" style="margin-bottom:12px"><img class="thumb" style="width:200px;height:112px" src="${v.thumbnail || ''}"><div class="grid g3" style="flex:1">${raw(stat('Views', fmtFull(v.view_count)))}${raw(stat('Likes', fmtFull(v.like_count), v.view_count ? h`<span class="muted">${pct(v.like_count / v.view_count, 2)} of views</span>` : ''))}${raw(stat('Comments', fmtFull(v.comment_count)))}</div></div>
        <div class="tabs" id="dr-tabs"><a class="active" data-t="over">Overview</a>${owned ? h`<a data-t="check">Checklist</a><a data-t="edit">Edit metadata</a>` : ''}${owned?.authorized ? h`<a data-t="ret">Retention</a>` : ''}<a data-t="hist">History</a><a data-t="sim">Similar</a></div>
        <div id="dr-body"></div>`;
      openDrawer(html);
      document.getElementById('dr-close').onclick = closeDrawer;
      const body = document.getElementById('dr-body');
      const tabs = {
        over: () => h`<div class="grid g2"><div class="card tight"><h3>Description</h3><div class="pre" style="max-height:260px;overflow:auto;font-size:12.5px">${v.description || '—'}</div></div>
          <div class="card tight"><h3>Tags (${v.tags.length})</h3><div class="pill-list">${v.tags.map(t => h`<span class="pill">${t}</span>`).join('') || h`<span class="muted">none</span>`}</div>
          ${age ? h`<h3 style="margin-top:14px">First ${age.ageDays} days vs channel peers</h3><div class="kv"><b>Views now</b><span>${fmtFull(age.viewsNow)}</span><b>Peer median at same age</b><span>${fmtFull(age.peerMedianAtSameAge)}</span><b>Index</b><span class="${(age.index || 0) >= 1 ? 'up' : 'down'}">${age.index ? age.index.toFixed(2) + '×' : '—'}</span><b>Percentile</b><span>${age.percentile !== null ? Math.round(age.percentile * 100) + 'th' : '—'}</span></div><div class="src">${age.note}</div>` : ''}
          <div class="row" style="margin-top:12px"><button class="sm" id="dr-board">Save to board</button><button class="sm" data-copy="${v.title}">Copy title</button></div></div></div>`,
        check: () => chk ? h`<div class="row" style="margin-bottom:10px">${raw(scoreRing(chk.score))}<div><b>Publishing checklist</b><div class="mini">Title heuristic ${chk.title.score}/100 · description ${chk.description.score}/100</div></div></div>${raw(checks(chk.items))}<h3 style="margin-top:14px">Title checks</h3>${raw(checks(chk.title.checks))}<h3 style="margin-top:14px">Description checks</h3>${raw(checks(chk.description.checks))}` : empty('Checklist only for owned videos'),
        edit: () => h`<div class="note">Changes are staged locally, then applied with one <code>videos.update</code> call (50 quota units) under Packaging → Staged edits. Nothing is sent to YouTube until you click Apply.</div>
          <div class="form" style="margin-top:12px"><label class="f">Title<input id="e-title" value="${v.title}"></label><label class="f">Description<textarea id="e-desc" style="min-height:160px">${v.description}</textarea></label><label class="f">Tags (comma separated)<input id="e-tags" value="${v.tags.join(', ')}"></label>
          <div class="row"><label class="f">Privacy<select id="e-priv"><option value="">keep (${v.privacy_status || 'unknown'})</option><option value="public">public</option><option value="unlisted">unlisted</option><option value="private">private</option></select></label><label class="f">Schedule publish (local time)<input id="e-pub" type="datetime-local"></label></div>
          <div class="row"><button class="primary" id="e-stage">Stage changes</button><span class="mini">${owned?.authorized ? '' : 'Applying requires Google connection.'}</span></div></div>`,
        ret: async () => { body.innerHTML = h`<div class="loading"><span class="spinner"></span> Loading retention…</div>`; try { const r = await api(`/analytics/${v.channel_id}/retention/${v.id}`); return h`<div class="grid g4">${raw(stat('At 10%', pct(r.checkpoints.p10)))}${raw(stat('At 30%', pct(r.checkpoints.p30)))}${raw(stat('At 50%', pct(r.checkpoints.p50)))}${raw(stat('At 90%', pct(r.checkpoints.p90)))}</div><div class="card" style="margin-top:12px"><h3>Audience retention (share still watching)</h3>${raw(lineChart([{ values: r.curve.map(c => c.audienceWatchRatio * 100) }, { values: r.curve.map(c => (c.relativeRetentionPerformance || 0) * 100), cls: 'b' }], { labels: r.curve.map(c => '     ' + Math.round(c.elapsedVideoTimeRatio * 100) + '%'), format: x => x.toFixed(0) + '%' }))}<div class="mini">Blue: absolute retention. Red: relative to similar-length videos (YouTube's comparison).</div></div><h3 style="margin-top:12px">Biggest drops</h3>${r.biggestDrops.map(d => h`<div class="check fail"><i>↓</i><div>−${(d.drop * 100).toFixed(1)} points at ${Math.round(d.at * 100)}% (${dur(Math.round(d.at * v.duration_sec))})</div></div>`).join('') || h`<div class="muted">No sharp drops detected.</div>`}`; } catch (e) { return h`<div class="note bad">${(e.message)}</div>`; } },
        hist: () => h`<div class="card tight"><h3>Daily view snapshots</h3>${raw(v.history.length > 1 ? lineChart([{ values: v.history.map(x => x.views) }], { labels: v.history.map(x => x.day) }) : h`<div class="muted">Daily snapshots start accumulating once the scheduler runs (first one 20 s after the app starts).</div>`)}</div>
          <h3 style="margin-top:14px">Packaging history (title / thumbnail / description / tag changes observed)</h3>${v.metadataHistory.length ? h`<table><thead><tr><th>When</th><th>Field</th><th>From</th><th>To</th></tr></thead><tbody>${v.metadataHistory.map(m => h`<tr><td>${date(m.observed_at)}</td><td>${m.field}</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${m.field === 'thumbnail' ? raw(h`<img class="thumb sm" src="${(m.old_value || '')}">`) : (m.old_value || '').slice(0, 120)}</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${m.field === 'thumbnail' ? raw(h`<img class="thumb sm" src="${(m.new_value || '')}">`) : (m.new_value || '').slice(0, 120)}</td></tr>`).join('')}</tbody></table>` : h`<div class="muted">No changes recorded yet. Each sync compares title, thumbnail, description and tags with the last stored version.</div>`}`,
        sim: async () => { body.innerHTML = h`<div class="loading"><span class="spinner"></span> Searching (100 quota units)…</div>`; try { const s = await api(`/videos/${v.id}/similar`); return h`<div class="mini" style="margin-bottom:8px">Query: "${s.query}"</div>${raw(resultTable(s.results.slice(0, 20)))}`; } catch (e) { return h`<div class="note bad">${(e.message)}</div>`; } },
      };
      const show = async t => { body.innerHTML = await tabs[t](); document.querySelectorAll('#dr-tabs a').forEach(a => a.classList.toggle('active', a.dataset.t === t)); wire(t); };
      const wire = t => {
        body.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copy(b.dataset.copy));
        const sb = body.querySelector('#dr-board'); if (sb) sb.onclick = () => saveToBoard('video', { id: v.id, title: v.title, thumbnail: v.thumbnail, channel_title: v.channel_title, view_count: v.view_count });
        const st = body.querySelector('#e-stage'); if (st) st.onclick = async () => {
          const edits = [];
          const nt = body.querySelector('#e-title').value, nd = body.querySelector('#e-desc').value, ntags = body.querySelector('#e-tags').value.split(',').map(s => s.trim()).filter(Boolean);
          if (nt !== v.title) edits.push({ field: 'title', newValue: nt });
          if (nd !== v.description) edits.push({ field: 'description', newValue: nd });
          if (JSON.stringify(ntags) !== JSON.stringify(v.tags)) edits.push({ field: 'tags', newValue: ntags });
          const pr = body.querySelector('#e-priv').value; if (pr) edits.push({ field: 'privacy', newValue: pr });
          const pub = body.querySelector('#e-pub').value; if (pub) edits.push({ field: 'publishAt', newValue: new Date(pub).toISOString() });
          if (!edits.length) return toast('Nothing changed');
          for (const e of edits) await api('/packaging/staged', { method: 'POST', body: { channelId: v.channel_id, videoId: v.id, ...e } });
          toast(`${edits.length} change(s) staged`, 'ok'); closeDrawer(); TD.go('/packaging/staged');
        };
        body.querySelectorAll('.vlink').forEach(a => a.onclick = e => { e.preventDefault(); openVideo(a.dataset.v); });
      };
      document.querySelectorAll('#dr-tabs a').forEach(a => a.onclick = () => show(a.dataset.t));
      show('over');
    } catch (e) { openDrawer(h`<div class="note bad">${(e.message)}</div>`); }
  }
  state.views.openVideo = openVideo;

  async function saveToBoard(kind, ref, note = '') {
    const ch = state.current; if (!ch) return toast('Select an owned channel first');
    let boards = await api(`/boards/${ch.id}`);
    if (!boards.length) { const name = prompt('Name your first board:', 'Inspiration'); if (!name) return; await api(`/boards/${ch.id}`, { method: 'POST', body: { name } }); boards = await api(`/boards/${ch.id}`); }
    const pick = boards.length === 1 ? boards[0] : boards[Number(prompt(boards.map((b, i) => `${i + 1}. ${b.name}`).join('\n') + '\n\nBoard number:', '1')) - 1];
    if (!pick) return;
    await api(`/boards/id/${pick.id}/items`, { method: 'POST', body: { kind, ref, note } });
    toast(`Saved to "${pick.name}"`, 'ok');
  }
  state.views.saveToBoard = saveToBoard;

  function resultTable(rows, { extra = null } = {}) {
    return h`<table><thead><tr><th>Video</th><th class="num">Views</th><th class="num">Views/day</th><th class="num">Ch. subs</th><th class="num">Views ÷ subs</th><th></th></tr></thead><tbody>${rows.map(r => h`<tr><td><a href="#" class="vlink" data-v="${r.id}">${raw(videoCell(r, { showChannel: true }))}</a></td><td class="num">${fmt(r.view_count)}</td><td class="num">${fmt(r.vpd)}</td><td class="num">${fmt(r.channel_subs)}</td><td class="num">${r.subs_ratio ? r.subs_ratio.toFixed(1) + '×' : '—'}</td><td>${extra ? raw(extra(r)) : ''}</td></tr>`).join('')}</tbody></table>`;
  }
  state.views.resultTable = resultTable;

  view('/library', async (main, r) => {
    const ch = state.current;
    if (!ch) { main.innerHTML = h`<h1>Video library</h1>${needOwned()}`; return; }
    const f = Object.assign({ format: 'all', sort: 'published_at', dir: 'desc', q: '', limit: 100, offset: 0 }, ls('libfilter') || {}, r.query);
    const data = await api(`/channels/${ch.id}/videos?` + new URLSearchParams(f));
    const seg = await api(`/channels/${ch.id}/segments`);
    const vs = await api(`/scores/channel/${ch.id}/videos`).catch(() => ({}));
    const medLong = seg.long.median || 1, medShort = seg.shorts.median || 1;
    const th = (key, label, num = false) => h`<th class="sortable ${num ? 'num' : ''}" data-sort="${key}">${label}${f.sort === key ? (f.dir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`;
    main.innerHTML = h`
      <div class="page-head"><div><h1>Video library</h1><div class="sub">${data.total} videos · long-form median ${fmt(seg.long.median)} views · Shorts median ${fmt(seg.shorts.median)}</div></div>
        <div class="actions"><a class="btn sm" href="/api/channels/${ch.id}/export/videos.csv">Export CSV</a><a class="btn sm" href="/api/channels/${ch.id}/backup">Backup JSON</a><button class="sm" id="sync">Sync</button></div></div>
      <div class="card tight row" style="margin-bottom:12px"><input id="q" placeholder="Search titles & descriptions" value="${f.q}" style="flex:1;min-width:200px">
        <select id="format"><option value="all" ${f.format === 'all' ? 'selected' : ''}>All formats</option><option value="long" ${f.format === 'long' ? 'selected' : ''}>Long-form</option><option value="shorts" ${f.format === 'shorts' ? 'selected' : ''}>Shorts</option><option value="live" ${f.format === 'live' ? 'selected' : ''}>Live</option></select>
        <input id="from" type="date" value="${f.from || ''}" title="from"><input id="to" type="date" value="${f.to || ''}" title="to"><button id="apply" class="primary sm">Filter</button></div>
      <div class="card"><table><thead><tr>${raw(th('title', 'Video'))}${raw(th('published_at', 'Published'))}${raw(th('view_count', 'Views', true))}<th class="num">Score</th><th class="num">vs median</th>${raw(th('like_count', 'Likes', true))}${raw(th('comment_count', 'Comments', true))}${raw(th('duration_sec', 'Length', true))}<th>Tags</th></tr></thead>
        <tbody>${data.videos.map(v => { const x = v.view_count / (v.is_short ? medShort : medLong); return h`<tr class="clickable" data-v="${v.id}"><td>${raw(videoCell(v))}</td><td>${date(v.published_at)}</td><td class="num">${fmtFull(v.view_count)}</td><td class="num">${vs[v.id] ? h`<span class="badge x ${vs[v.id].score >= 70 ? 'ok' : vs[v.id].score < 45 ? 'bad' : 'warn'}" title="grade ${vs[v.id].grade}">${vs[v.id].score}</span>` : '—'}</td><td class="num"><span class="badge x ${x >= 3 ? 'ok' : x < 0.5 ? 'bad' : ''}">${x.toFixed(1)}×</span></td><td class="num">${fmtFull(v.like_count)}</td><td class="num">${fmtFull(v.comment_count)}</td><td class="num">${dur(v.duration_sec)}</td><td class="num">${v.tags.length}</td></tr>`; }).join('')}</tbody></table>
        <div class="row between" style="margin-top:10px"><span class="mini">Showing ${Number(f.offset) + 1}–${Math.min(data.total, Number(f.offset) + data.videos.length)} of ${data.total}</span><div class="row"><button class="sm" id="prev" ${Number(f.offset) === 0 ? 'disabled' : ''}>← Prev</button><button class="sm" id="next" ${Number(f.offset) + data.videos.length >= data.total ? 'disabled' : ''}>Next →</button></div></div></div>`;
    const apply = (patch = {}) => { const nf = { ...f, ...patch }; ls('libfilter', { format: nf.format, sort: nf.sort, dir: nf.dir }); TD.go('/library', nf); };
    main.querySelector('#apply').onclick = () => apply({ q: main.querySelector('#q').value, format: main.querySelector('#format').value, from: main.querySelector('#from').value, to: main.querySelector('#to').value, offset: 0 });
    main.querySelector('#q').onkeydown = e => { if (e.key === 'Enter') main.querySelector('#apply').click(); };
    main.querySelectorAll('th.sortable').forEach(t => t.onclick = () => apply({ sort: t.dataset.sort, dir: f.sort === t.dataset.sort && f.dir === 'desc' ? 'asc' : 'desc', offset: 0 }));
    main.querySelectorAll('tr.clickable').forEach(t => t.onclick = () => openVideo(t.dataset.v));
    main.querySelector('#prev').onclick = () => apply({ offset: Math.max(0, Number(f.offset) - Number(f.limit)) });
    main.querySelector('#next').onclick = () => apply({ offset: Number(f.offset) + Number(f.limit) });
    main.querySelector('#sync').onclick = async e => { busy(e.target, true); try { const r = await api(`/channels/${ch.id}/sync`, { method: 'POST', body: { force: true } }); toast(`Synced ${r.synced}`); TD.route(); } catch (x) { err(x); } busy(e.target, false); };
    if (r.query.v) openVideo(r.query.v);
  });
})();
