/* Analytics (owner) */
(() => {
  const { view, api, h, raw, esc, fmt, fmtFull, pct, dur, date, videoCell, stat, empty, needOwned, needAuth, lineChart, barChart, hbars, err, toast, busy, state, openVideo, delta } = TD;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const TABS = [['overview', 'Overview', true], ['traffic', 'Traffic & search terms', true], ['audience', 'Audience', true], ['subscribers', 'Subscribers', true], ['watch', 'Watch hours & YPP', true], ['content', 'Content types', false], ['slots', 'Publish slots', false], ['studio', 'Impressions & CTR (Studio import)', false], ['revenue', 'Revenue', true]];

  view('/analytics', async (main, r) => {
    const ch = state.current;
    if (!ch) { main.innerHTML = h`<h1>Analytics</h1>${needOwned()}`; return; }
    const tab = r.path.split('/')[2] || 'overview';
    const days = Number(r.query.days || 28);
    main.innerHTML = h`<div class="page-head"><div><h1>Analytics · ${ch.title}</h1><div class="sub">${ch.authorized ? 'YouTube Analytics API (owner-authorized), lagging ~3 days' : 'Public data only — connect with Google for owner analytics'}</div></div>
      <div class="actions"><select id="days">${[7, 28, 90, 365].map(d => h`<option value="${d}" ${d === days ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select></div></div>
      <div class="tabs">${TABS.map(([k, l, needs]) => h`<a href="#/analytics/${k}?days=${days}" class="${tab === k ? 'active' : ''} ${needs && !ch.authorized ? 'muted' : ''}">${l}</a>`).join('')}</div><div id="body"><div class="loading"><span class="spinner"></span></div></div>`;
    main.querySelector('#days').onchange = e => TD.go('/analytics/' + tab, { days: e.target.value });
    const body = main.querySelector('#body');
    const needs = TABS.find(t => t[0] === tab)?.[2];
    if (needs && !ch.authorized) { body.innerHTML = needAuth(ch); return; }
    try { body.innerHTML = await ({ overview, traffic, audience, subscribers, watch, content, slots, studio, revenue }[tab] || overview)(ch, days); } catch (e) { body.innerHTML = h`<div class="note bad">${(e.message)}</div>`; }
    body.querySelectorAll('.vlink').forEach(a => a.onclick = e => { e.preventDefault(); openVideo(a.dataset.v); });
    wire(body, ch);
  });

  async function overview(ch, days) {
    const [ov, top] = await Promise.all([api(`/analytics/${ch.id}/overview?days=${days}`), api(`/analytics/${ch.id}/top?days=${days}`)]);
    const t = ov.totals;
    return h`<div class="grid g4">${raw(stat('Views', fmt(t.views), delta(ov.delta.views)))}${raw(stat('Watch hours', fmt((t.estimatedMinutesWatched || 0) / 60), delta(ov.delta.estimatedMinutesWatched)))}${raw(stat('Avg view duration', dur(Math.round(t.averageViewDuration || 0)), delta(ov.delta.averageViewDuration)))}${raw(stat('Avg % viewed', (t.averageViewPercentage || 0).toFixed(1) + '%', delta(ov.delta.averageViewPercentage)))}</div>
      <div class="grid g4" style="margin-top:12px">${raw(stat('Subs gained', fmtFull(t.subscribersGained), delta(ov.delta.subscribersGained)))}${raw(stat('Subs lost', fmtFull(t.subscribersLost), delta(ov.delta.subscribersLost)))}${raw(stat('Likes', fmtFull(t.likes), delta(ov.delta.likes)))}${raw(stat('Comments', fmtFull(t.comments), delta(ov.delta.comments)))}</div>
      <div class="grid g2" style="margin-top:12px"><div class="card"><h2>Daily views</h2>${raw(lineChart([{ values: ov.daily.map(d => d.views) }], { labels: ov.daily.map(d => d.day) }))}</div><div class="card"><h2>Daily watch minutes</h2>${raw(lineChart([{ values: ov.daily.map(d => d.estimatedMinutesWatched) }], { labels: ov.daily.map(d => d.day) }))}</div></div>
      <div class="card" style="margin-top:12px"><h2>Top videos in period <span class="mini">vs previous period: ${raw(delta(ov.delta.views))} views</span></h2><table><thead><tr><th>Video</th><th class="num">Views</th><th class="num">Watch min</th><th class="num">Avg dur</th><th class="num">Avg %</th><th class="num">Subs +</th></tr></thead><tbody>${top.map(v => h`<tr><td><a href="#" class="vlink" data-v="${v.video}">${raw(videoCell({ ...v, title: v.title || v.video }))}</a></td><td class="num">${fmtFull(v.views)}</td><td class="num">${fmt(v.estimatedMinutesWatched)}</td><td class="num">${dur(Math.round(v.averageViewDuration || 0))}</td><td class="num">${(v.averageViewPercentage || 0).toFixed(1)}%</td><td class="num">${fmtFull(v.subscribersGained)}</td></tr>`).join('')}</tbody></table></div>
      <div class="src">${ov.source} · ${ov.period.startDate} → ${ov.period.endDate}</div>`;
  }
  async function traffic(ch, days) {
    const t = await api(`/analytics/${ch.id}/traffic?days=${days}`);
    return h`<div class="grid g2"><div class="card"><h2>Traffic sources</h2>${raw(hbars(t.types, { label: x => x.insightTrafficSourceType.replace(/_/g, ' '), value: x => x.views }))}</div>
      <div class="card"><h2>Search terms bringing views <span class="badge info">YouTube search</span></h2>${t.searchTerms.length ? raw(hbars(t.searchTerms, { label: x => x.insightTrafficSourceDetail, value: x => x.views })) : h`<div class="muted">No search-term rows for this period.</div>`}<div class="src">These are real queries viewers typed — the best keyword list you have. Send any of them to Keywords.</div></div></div>
      <div class="grid g2" style="margin-top:12px"><div class="card"><h2>Suggested from (videos that recommend you)</h2>${t.suggestedFrom.length ? raw(hbars(t.suggestedFrom, { label: x => x.insightTrafficSourceDetail, value: x => x.views })) : h`<div class="muted">None in period.</div>`}</div><div class="card"><h2>External sites</h2>${t.externalSites.length ? raw(hbars(t.externalSites, { label: x => x.insightTrafficSourceDetail, value: x => x.views })) : h`<div class="muted">None in period.</div>`}</div></div>`;
  }
  async function audience(ch, days) {
    const [g, d, dev] = await Promise.all([api(`/analytics/${ch.id}/geo?days=${days}`), api(`/analytics/${ch.id}/demographics?days=${days}`).catch(() => ({ rows: [] })), api(`/analytics/${ch.id}/devices?days=${days}`).catch(() => [])]);
    const ages = [...new Set(d.rows.map(x => x.ageGroup))];
    return h`<div class="grid g2"><div class="card"><h2>Countries (views)</h2>${g.rows.length ? h`${raw(hbars(g.rows.slice(0, 20), { label: x => x.country, value: x => x.views }))}<table style="margin-top:10px"><thead><tr><th>Country</th><th class="num">Views</th><th class="num">Share</th><th class="num">Avg duration</th></tr></thead><tbody>${g.rows.slice(0, 15).map(x => h`<tr><td>${x.country}</td><td class="num">${fmtFull(x.views)}</td><td class="num">${pct(x.share)}</td><td class="num">${dur(Math.round(x.averageViewDuration || 0))}</td></tr>`).join('')}</tbody></table>` : h`<div class="muted">YouTube withholds the country breakdown when a period has too few views. Try a longer range (90 or 365 days).</div>`}</div>
      <div class="stack"><div class="card"><h2>Age & gender (viewer %)</h2>${ages.length ? h`<table><thead><tr><th>Age</th><th class="num">Female</th><th class="num">Male</th><th class="num">Other</th></tr></thead><tbody>${ages.map(a => { const f = d.rows.find(x => x.ageGroup === a && x.gender === 'female')?.viewerPercentage || 0, m = d.rows.find(x => x.ageGroup === a && x.gender === 'male')?.viewerPercentage || 0, o = d.rows.find(x => x.ageGroup === a && x.gender === 'user_specified')?.viewerPercentage || 0; return h`<tr><td>${a.replace('age', '')}</td><td class="num">${f.toFixed(1)}%</td><td class="num">${m.toFixed(1)}%</td><td class="num">${o.toFixed(1)}%</td></tr>`; }).join('')}</tbody></table>` : h`<div class="muted">YouTube withholds demographics until the channel has enough signed-in viewers.</div>`}</div>
      <div class="card"><h2>Devices</h2>${dev.length ? raw(hbars(dev, { label: x => x.deviceType, value: x => x.views })) : h`<div class="muted">No data</div>`}</div></div></div>`;
  }
  async function subscribers(ch, days) {
    const s = await api(`/analytics/${ch.id}/subscribers?days=${days}`);
    const net = s.daily.map(d => d.subscribersGained - d.subscribersLost);
    return h`<div class="grid g2"><div class="card"><h2>Net subscribers per day</h2>${raw(barChart(net, { labels: s.daily.map(d => d.day.slice(5)) }))}</div><div class="card"><h2>Gained vs lost</h2>${raw(lineChart([{ values: s.daily.map(d => d.subscribersGained) }, { values: s.daily.map(d => d.subscribersLost), cls: 'b' }], { labels: s.daily.map(d => d.day) }))}<div class="mini">Blue gained · red lost</div></div></div>
      <div class="card" style="margin-top:12px"><h2>Videos driving subscriptions</h2><table><thead><tr><th>Video</th><th class="num">Gained</th><th class="num">Lost</th><th class="num">Net</th><th class="num">Views</th><th class="num">Subs / 1K views</th></tr></thead><tbody>${s.byVideo.map(v => h`<tr><td><a href="#" class="vlink" data-v="${v.video}">${v.title}</a></td><td class="num">${fmtFull(v.subscribersGained)}</td><td class="num">${fmtFull(v.subscribersLost)}</td><td class="num ${v.net >= 0 ? 'up' : 'down'}">${fmtFull(v.net)}</td><td class="num">${fmtFull(v.views)}</td><td class="num">${v.views ? ((v.subscribersGained / v.views) * 1000).toFixed(1) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  }
  async function watch(ch) {
    const w = await api(`/analytics/${ch.id}/watch-hours`);
    return h`<div class="grid g2"><div class="card"><h2>YouTube Partner Program progress</h2><div class="kv"><b>Public watch hours (365d)</b><span>${fmtFull(Math.round(w.publicWatchHours))} / 4,000</span></div><div class="progress" style="margin:6px 0 12px"><i style="width:${w.ypp.watchHoursPct * 100}%"></i></div><div class="kv"><b>Subscribers</b><span>${fmtFull(w.subscribers)} / 1,000</span></div><div class="progress" style="margin:6px 0 12px"><i style="width:${w.ypp.subsPct * 100}%"></i></div><div class="note">${w.note}</div></div>
      <div class="card"><h2>Watch hours per day</h2>${raw(lineChart([{ values: w.daily.map(d => d.estimatedMinutesWatched / 60) }], { labels: w.daily.map(d => d.day), format: x => x.toFixed(0) }))}</div></div>`;
  }
  async function content(ch, days) {
    const c = await api(`/analytics/${ch.id}/content-types?days=${days}`);
    return h`<div class="grid g2"><div class="card"><h2>Library mix (synced videos)</h2>${raw(hbars(c.library, { label: x => `${x.type} (${x.count} videos)`, value: x => x.views }))}<div class="mini">Bars = total views by format.</div></div><div class="card"><h2>Views by content type (Analytics API, period)</h2>${c.analytics.length ? raw(hbars(c.analytics, { label: x => x.creatorContentType, value: x => x.views })) : h`<div class="muted">Requires Google connection or no data in period.</div>`}</div></div>`;
  }
  async function slots(ch) {
    const s = await api(`/channels/${ch.id}/publish-slots`);
    const cells = Object.fromEntries(s.cells.map(c => [`${c.dow}-${c.hourUTC}`, c]));
    const max = Math.max(...s.cells.map(c => c.index), 1);
    return h`<div class="note">${s.method} Sample: ${s.sampleSize} videos.</div>
      <div class="card" style="margin-top:12px"><h2>Performance by publish weekday</h2>${raw(hbars(s.byWeekday.filter(d => d.n), { label: d => `${DOW[d.dow]} (${d.n})`, value: d => d.index || 0, format: x => x.toFixed(2) + '×' }))}</div>
      <div class="card" style="margin-top:12px"><h2>Weekday × hour (UTC) heatmap</h2><div class="cal"><div></div>${Array.from({ length: 24 }, (_, i) => h`<div class="h">${i}</div>`).join('')}${[0, 1, 2, 3, 4, 5, 6].map(d => h`<div class="h" style="text-align:left">${DOW[d]}</div>${Array.from({ length: 24 }, (_, hh) => { const c = cells[`${d}-${hh}`]; const a = c ? Math.min(1, c.index / max) : 0; return h`<div class="c" title="${c ? `${DOW[d]} ${hh}:00 UTC — ${c.n} uploads, ${c.index.toFixed(2)}× median` : ''}" style="background:${c ? `rgba(90,169,255,${0.15 + a * 0.85})` : ''}"></div>`; })}`)}</div><div class="mini" style="margin-top:8px">Darker = higher indexed views-per-day. Needs ≥ 8 uploads to mean anything; YouTube Studio's "when your viewers are on YouTube" is the only true audience-activity chart.</div></div>`;
  }
  async function studio(ch) {
    const s = await api(`/analytics/${ch.id}/studio`);
    return h`<div class="grid g2"><div class="card"><h2>Import YouTube Studio export</h2><p class="mini">Impressions and click-through rate are not exposed by any API. Export them from Studio and paste or drop the CSV here:<br>YouTube Studio → Analytics → <b>Advanced mode</b> → Content tab → add columns <i>Impressions</i>, <i>Impressions click-through rate</i>, <i>Average view duration</i> → Export current view → CSV.</p>
      <div class="dropzone" id="drop">Drop a Studio CSV here, or click to choose</div><input type="file" id="file" accept=".csv,text/csv" style="display:none"><textarea id="csv" class="mono" placeholder="…or paste CSV text" style="margin-top:8px;min-height:80px"></textarea><div class="row" style="margin-top:8px"><input id="period" placeholder="Label, e.g. 2026-10 28d"><button id="imp" class="primary">Import</button></div></div>
      <div class="card"><h2>Latest import</h2>${s.rows.length ? h`<div class="grid g2">${raw(stat('Impression-weighted CTR', s.impressionWeightedCtr !== null ? s.impressionWeightedCtr.toFixed(2) + '%' : '—'))}${raw(stat('Rows', s.rows.length, h`<span class="muted">${s.imports} import(s) stored</span>`))}</div><h3 style="margin-top:12px">High impressions, low CTR (packaging candidates)</h3>${s.lowCtrHighImpressions.map(r => h`<div class="row between" style="padding:5px 0;border-bottom:1px solid var(--line)"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.lib_title || r.video_title || r.video_id}</span><span class="badge">${fmt(r.impressions)} imp</span><span class="badge bad">${r.ctr?.toFixed(2)}% CTR</span></div>`).join('') || h`<div class="muted">Nothing below average.</div>`}` : h`<div class="muted">No import yet.</div>`}</div></div>
      ${s.rows.length ? h`<div class="card" style="margin-top:12px"><h2>All rows</h2><table><thead><tr><th>Video</th><th class="num">Impressions</th><th class="num">CTR</th><th class="num">Avg view dur</th><th class="num">Avg %</th><th class="num">Views</th></tr></thead><tbody>${s.rows.map(r => h`<tr><td>${r.lib_title || r.video_title || r.video_id}</td><td class="num">${fmtFull(r.impressions)}</td><td class="num">${r.ctr !== null ? r.ctr.toFixed(2) + '%' : '—'}</td><td class="num">${r.avg_view_duration_sec ? dur(Math.round(r.avg_view_duration_sec)) : '—'}</td><td class="num">${r.avg_view_pct !== null ? r.avg_view_pct.toFixed(1) + '%' : '—'}</td><td class="num">${fmtFull(r.views)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  }
  async function revenue(ch, days) {
    const r = await api(`/analytics/${ch.id}/revenue?days=${days}`);
    if (!r.available) return h`<div class="note warn">Revenue not available: ${(r.reason)}. The channel must be in the Partner Program and the Google connection must include the monetary scope (reconnect under Channels if you joined YPP after connecting).</div><div style="margin-top:12px"><a class="btn" href="#/calculators">Open the earnings scenario calculator</a></div>`;
    return h`<div class="grid g4">${raw(stat('Estimated revenue', '$' + r.totals.revenue.toFixed(2)))}${raw(stat('RPM', r.totals.rpm !== null ? '$' + r.totals.rpm.toFixed(2) : '—'))}${raw(stat('Monetized playbacks', fmt(r.totals.monetized)))}${raw(stat('Views', fmt(r.totals.views)))}</div><div class="card" style="margin-top:12px"><h2>Daily revenue</h2>${raw(lineChart([{ values: r.daily.map(d => d.estimatedRevenue) }], { labels: r.daily.map(d => d.day), format: x => '$' + x.toFixed(0) }))}</div><div class="src">${r.source}</div>`;
  }
  function wire(body, ch) {
    const drop = body.querySelector('#drop'); if (!drop) return;
    const file = body.querySelector('#file'), ta = body.querySelector('#csv');
    drop.onclick = () => file.click();
    file.onchange = () => { const f = file.files[0]; if (f) f.text().then(t => ta.value = t); };
    drop.ondragover = e => { e.preventDefault(); drop.style.borderColor = 'var(--info)'; };
    drop.ondrop = e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) f.text().then(t => ta.value = t); };
    body.querySelector('#imp').onclick = async e => { if (!ta.value.trim()) return toast('Paste or drop a CSV first'); busy(e.target, true); try { const r = await api(`/analytics/${ch.id}/studio-import`, { method: 'POST', body: { csv: ta.value, period: body.querySelector('#period').value } }); toast(`Imported ${r.imported} rows (${Object.values(r.columnsFound).join(', ')})`, 'ok'); TD.route(); } catch (x) { err(x); } busy(e.target, false); };
  }
})();
