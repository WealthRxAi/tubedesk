/* Competitors: watchlist, comparison, upload feed, alerts, report cards, forecasts */
(() => {
  const { view, api, h, raw, esc, fmt, fmtFull, pct, ago, date, videoCell, stat, empty, needOwned, lineChart, hbars, err, toast, busy, state, openVideo } = TD;

  view('/competitors', async (main, r) => {
    const ch = state.current; if (!ch) { main.innerHTML = h`<h1>Competitors</h1>${needOwned()}`; return; }
    const tab = r.path.split('/')[2] || 'compare';
    main.innerHTML = h`<div class="page-head"><div><h1>Competitors · ${ch.title}</h1><div class="sub">Public data for channels you choose to track. Daily snapshots build growth history; new uploads, breakouts and packaging changes raise alerts.</div></div>
      <div class="actions"><button id="refresh" class="sm">Refresh all now</button></div></div>
      <div class="card tight row" style="margin-bottom:12px"><input id="add" placeholder="Add competitor: @handle, channel URL, UC… id or a video URL" style="flex:1;min-width:260px"><input id="note" placeholder="note (optional)" style="width:160px"><button id="addbtn" class="primary">Track</button></div>
      <div class="tabs">${[['compare', 'Comparison'], ['feed', 'Upload feed'], ['alerts', `Alerts${state.alertCount ? ` (${state.alertCount})` : ''}`], ['cards', 'Report cards & forecasts'], ['history', 'Packaging history']].map(([k, l]) => h`<a href="#/competitors/${k}" class="${tab === k ? 'active' : ''}">${l}</a>`).join('')}</div><div id="body"><div class="loading"><span class="spinner"></span></div></div>`;
    main.querySelector('#addbtn').onclick = async e => { const input = main.querySelector('#add').value.trim(); if (!input) return; busy(e.target, true); try { const c = await api(`/competitors/${ch.id}`, { method: 'POST', body: { input, note: main.querySelector('#note').value } }); toast(`Tracking ${c.title}`, 'ok'); TD.route(); } catch (x) { err(x); } busy(e.target, false); };
    main.querySelector('#refresh').onclick = async e => { busy(e.target, true); try { const r2 = await api(`/competitors/${ch.id}/refresh`, { method: 'POST' }); toast(`Refreshed ${r2.refreshed} channels, ${r2.alerts.length} new alerts`, 'ok'); await TD.refreshChannels(); TD.route(); } catch (x) { err(x); } busy(e.target, false); };
    const body = main.querySelector('#body');
    try { body.innerHTML = await ({ compare, feed, alerts, cards, history }[tab])(ch, r); } catch (e) { body.innerHTML = h`<div class="note bad">${(e.message)}</div>`; }
    body.querySelectorAll('.vlink').forEach(a => a.onclick = e => { e.preventDefault(); openVideo(a.dataset.v); });
    body.querySelectorAll('[data-untrack]').forEach(b => b.onclick = async () => { if (confirm('Stop tracking this channel?')) { await api(`/competitors/${ch.id}/${b.dataset.untrack}`, { method: 'DELETE' }); TD.route(); } });
    body.querySelectorAll('[data-read]').forEach(b => b.onclick = async () => { await api(`/alerts/read/${b.dataset.read}`, { method: 'POST' }); await TD.refreshChannels(); TD.route(); });
    const ra = body.querySelector('#readall'); if (ra) ra.onclick = async () => { await api(`/alerts/${ch.id}/read-all`, { method: 'POST' }); await TD.refreshChannels(); TD.route(); };
  });

  async function compare(ch) {
    const d = await api(`/competitors/${ch.id}/compare?days=30`);
    if (d.channels.length < 2) return empty('Track at least one competitor to compare.');
    const cols = [['subscribers', 'Subscribers', fmtFull], ['totalViews', 'Total views', fmt], ['totalVideos', 'Videos', fmtFull], ['viewsPerVideo', 'Views / video', fmt], ['medianViewsLong', 'Median long-form views', fmt], ['medianViewsShorts', 'Median Shorts views', fmt], ['uploadsPerWeek', 'Uploads / week (30d)', x => x], ['recentMedianViews', 'Median views, last 30d uploads', fmt], ['engagement', 'Engagement (likes+comments ÷ views)', x => pct(x, 2)], ['subsGrowthN', 'Subs gained (snapshot window)', x => x === null ? '—' : fmtFull(x)], ['viewsGrowthN', 'Views gained (snapshot window)', x => x === null ? '—' : fmt(x)], ['snapshotDays', 'Days of snapshots', x => x]];
    return h`<div class="card" style="overflow:auto"><table><thead><tr><th>Metric</th>${d.channels.map(c => h`<th>${raw(h`<div class="vt"><img class="avatar" src="${(c.thumbnail || '')}"><div><div class="t">${(c.title)}</div><div class="m">${c.kind === 'owned' ? 'you' : raw(h`<button class="sm ghost" data-untrack="${(c.id)}">untrack</button>`)}</div></div></div>`)}</th>`).join('')}</tr></thead><tbody>${cols.map(([k, l, f]) => { const vals = d.channels.map(c => c[k]); const best = Math.max(...vals.map(v => typeof v === 'number' ? v : -Infinity)); return h`<tr><td>${l}</td>${vals.map(v => h`<td class="num ${typeof v === 'number' && v === best && d.channels.length > 1 ? 'up' : ''}">${f(v)}</td>`).join('')}</tr>`; }).join('')}</tbody></table><div class="src">${(d.note)}</div></div>`;
  }
  async function feed(ch) {
    const rows = await api(`/competitors/${ch.id}/feed?days=30`);
    return rows.length ? h`<div class="card"><table><thead><tr><th>Video</th><th>Channel</th><th>Published</th><th class="num">Views</th><th class="num">Views/day</th><th class="num">Views ÷ subs</th></tr></thead><tbody>${rows.map(v => { const age = Math.max(1, (Date.now() - new Date(v.published_at)) / 86400000); return h`<tr><td><a href="#" class="vlink" data-v="${v.id}">${raw(videoCell(v))}</a></td><td>${v.channel_title}</td><td>${ago(v.published_at)}</td><td class="num">${fmtFull(v.view_count)}</td><td class="num">${fmt(v.view_count / age)}</td><td class="num">${v.channel_subs ? (v.view_count / v.channel_subs).toFixed(2) + '×' : '—'}</td></tr>`; }).join('')}</tbody></table></div>` : empty('No competitor uploads in the last 30 days (or nothing tracked yet).');
  }
  async function alerts(ch) {
    const rows = await api(`/alerts/${ch.id}`);
    return h`<div class="card"><div class="row between" style="margin-bottom:8px"><h2 style="margin:0">Alerts</h2><button class="sm" id="readall">Mark all read</button></div>${rows.length ? rows.map(a => h`<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line);opacity:${a.read ? .55 : 1}"><div><span class="badge ${a.kind === 'breakout' ? 'ok' : a.kind === 'new_upload' ? 'info' : 'warn'}">${a.kind.replace(/_/g, ' ')}</span> ${a.title}<div class="mini">${ago(a.created_at)}</div></div><div class="row">${a.payload.videoId ? h`<a href="#" class="vlink btn sm" data-v="${a.payload.videoId}">Open</a>` : ''}${!a.read ? h`<button class="sm ghost" data-read="${a.id}">Read</button>` : ''}</div></div>`).join('') : h`<div class="muted">No alerts yet.</div>`}</div>`;
  }
  async function cards(ch, r) {
    const comps = await api(`/competitors/${ch.id}`);
    const all = [ch, ...comps];
    const sel = r.query.c || ch.id;
    const [rc, fc] = await Promise.all([api(`/channels/${sel}/report-card`), api(`/channels/${sel}/forecast?days=90`)]);
    return h`<div class="row" style="margin-bottom:12px">${all.map(c => h`<a class="pill ${c.id === sel ? 'on' : ''}" href="#/competitors/cards?c=${c.id}">${c.title}</a>`).join('')}</div>
      <div class="grid g2"><div class="card"><h2>Report card · ${rc.title}</h2><div class="grid g3">${raw(stat('Subscribers', fmtFull(rc.subscribers)))}${raw(stat('Total views', fmt(rc.totalViews)))}${raw(stat('Videos', fmtFull(rc.totalVideos)))}</div><table style="margin-top:10px"><tbody>${rc.grades.map(g => h`<tr><td>${g.name}<div class="mini">${g.detail}</div></td><td class="num"><span class="badge x ${g.grade === 'A' ? 'ok' : g.grade === 'B' ? 'info' : 'warn'}">${g.grade}</span></td></tr>`).join('')}</tbody></table><div class="src">${rc.disclaimer}</div><div class="row" style="margin-top:8px"><button class="sm" id="copycard">Copy summary</button></div></div>
      <div class="card"><h2>90-day scenarios</h2>${fc.available ? h`<table><thead><tr><th>Scenario</th><th class="num">Subscribers</th><th class="num">Total views</th></tr></thead><tbody>${['low', 'base', 'high'].map(k => h`<tr><td>${k}</td><td class="num">${fmtFull(fc.scenarios[k].subs)}</td><td class="num">${fmt(fc.scenarios[k].views)}</td></tr>`).join('')}</tbody></table><div class="src">Based on ${fc.basedOnDays} daily snapshots. ${fc.note}</div>` : h`<div class="muted">${fc.reason}</div>`}</div></div>
      <div class="card" style="margin-top:12px"><h2>Subscriber history (snapshots)</h2>${raw(rc.history.length > 1 ? lineChart([{ values: rc.history.map(x => x.subs) }], { labels: rc.history.map(x => x.day) }) : h`<div class="muted">Daily snapshots accumulate automatically from the scheduler.</div>`)}</div>`;
  }
  async function history(ch) {
    const comps = await api(`/competitors/${ch.id}`);
    const feedRows = await api(`/competitors/${ch.id}/feed?days=3650`);
    const out = [];
    for (const v of feedRows.slice(0, 150)) { const d = await api(`/videos/${v.id}`); for (const m of d.metadataHistory) out.push({ ...m, video: d }); }
    out.sort((a, b) => b.observed_at.localeCompare(a.observed_at));
    return out.length ? h`<div class="card"><table><thead><tr><th>When</th><th>Video</th><th>Field</th><th>From</th><th>To</th></tr></thead><tbody>${out.slice(0, 200).map(m => h`<tr><td>${date(m.observed_at)}</td><td><a href="#" class="vlink" data-v="${m.video.id}">${m.video.title}</a><div class="mini">${m.video.channel_title || ''}</div></td><td>${m.field}</td><td>${m.field === 'thumbnail' ? raw(h`<img class="thumb sm" src="${(m.old_value || '')}">`) : (m.old_value || '').slice(0, 100)}</td><td>${m.field === 'thumbnail' ? raw(h`<img class="thumb sm" src="${(m.new_value || '')}">`) : (m.new_value || '').slice(0, 100)}</td></tr>`).join('')}</tbody></table><div class="src">Every sync compares each tracked video's title, thumbnail, description and tags with the last stored copy. Retention: kept locally only.</div></div>` : empty(comps.length ? 'No packaging changes observed yet. Changes appear after competitors edit a title/thumbnail and the daily refresh runs.' : 'Track a competitor first.');
  }
})();
