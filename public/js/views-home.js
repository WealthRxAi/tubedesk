/* Dashboard + Channels */
(() => {
  const { view, api, h, raw, esc, fmt, fmtFull, pct, ago, delta, videoCell, stat, empty, needOwned, lineChart, barChart, err, toast, busy, state, go, refreshChannels, openVideo } = TD;

  view('/', async (main) => {
    const ch = state.current;
    if (!ch) { main.innerHTML = h`<h1>Dashboard</h1>${needOwned()}`; return; }
    const [hist, seg, alerts, lib, cs] = await Promise.all([
      api(`/channels/${ch.id}/history?days=90`), api(`/channels/${ch.id}/segments`), api(`/alerts/${ch.id}?unread=1`), api(`/channels/${ch.id}/videos?limit=8`), api(`/scores/channel/${ch.id}`).catch(() => null),
    ]);
    let ov = null, ovErr = null;
    if (ch.authorized) { try { ov = await api(`/analytics/${ch.id}/overview?days=28`); } catch (e) { ovErr = e.message; } }
    const first = hist[0], last = hist[hist.length - 1];
    const subsDelta = first && last && hist.length > 1 ? last.subs - first.subs : null;
    const viewsDelta = first && last && hist.length > 1 ? last.views - first.views : null;
    main.innerHTML = h`
      <div class="page-head"><div><h1>${ch.title}</h1><div class="sub">${ch.handle || ch.id} · ${ch.kind === 'owned' ? (ch.authorized ? 'Google-connected (full analytics)' : 'public data only') : ''} · last synced ${ago(ch.last_synced)}</div></div>
        <div class="actions"><button id="sync" class="sm">Sync now</button><a class="btn sm" href="#/analytics">Analytics</a><a class="btn sm" href="#/coach">Ask the coach</a></div></div>
      ${cs ? h`<div class="card" style="margin-bottom:14px"><div class="row" style="gap:18px;align-items:center"><div class="score ${TD.scoreClass(cs.score)}" style="width:64px;height:64px;font-size:22px">${cs.score}</div><div style="flex:1;min-width:200px"><h2 style="margin:0">Channel score · grade ${cs.grade}</h2><div class="mini">${cs.advice}</div></div><div class="grid g4" style="flex:2;min-width:280px">${raw(Object.entries(cs.components).map(([k, v]) => h`<div><div class="mini">${k}</div><div class="progress"><i style="width:${v}%;background:${v >= 70 ? 'var(--ok)' : v >= 40 ? 'var(--warn)' : 'var(--bad)'}"></i></div><div class="mini">${v}</div></div>`))}</div></div><div class="src">Weights: ${Object.entries(cs.weights).map(([k, w]) => `${k} ${Math.round(w * 100)}%`).join(' · ')}. Based on ${cs.sample.videos} synced videos, ${cs.sample.recent90d} in the last 90 days, ${cs.sample.snapshotDays} days of snapshots.</div></div>` : ''}
      <div class="grid g4">
        ${raw(stat('Subscribers', fmtFull(ch.subscriber_count), subsDelta !== null ? h`<span class="${subsDelta >= 0 ? 'up' : 'down'}">${subsDelta >= 0 ? '+' : ''}${fmtFull(subsDelta)} over ${hist.length}d of snapshots</span>` : h`<span class="muted">snapshots build daily</span>`))}
        ${raw(stat('Total views', fmt(ch.view_count), viewsDelta !== null ? h`<span class="up">+${fmt(viewsDelta)} over ${hist.length}d</span>` : ''))}
        ${raw(stat('Videos', fmtFull(ch.video_count), h`<span class="muted">${lib.total} synced locally</span>`))}
        ${raw(ov ? stat('Views, last 28d', fmt(ov.totals.views), delta(ov.delta.views)) : stat('Long-form median views', fmt(seg.long.median), h`<span class="muted">Shorts median ${fmt(seg.shorts.median)}</span>`))}
      </div>
      ${ov ? h`<div class="grid g4" style="margin-top:14px">
        ${raw(stat('Watch time (hours), 28d', fmt((ov.totals.estimatedMinutesWatched || 0) / 60), delta(ov.delta.estimatedMinutesWatched)))}
        ${raw(stat('Avg view duration', TD.dur(Math.round(ov.totals.averageViewDuration || 0)), delta(ov.delta.averageViewDuration)))}
        ${raw(stat('Avg % viewed', (ov.totals.averageViewPercentage || 0).toFixed(1) + '%', delta(ov.delta.averageViewPercentage)))}
        ${raw(stat('Net subscribers, 28d', fmtFull((ov.totals.subscribersGained || 0) - (ov.totals.subscribersLost || 0)), h`<span class="muted">+${fmtFull(ov.totals.subscribersGained)} / −${fmtFull(ov.totals.subscribersLost)}</span>`))}
      </div>` : ovErr ? h`<div class="note warn" style="margin-top:14px">Owner analytics unavailable: ${ovErr}</div>` : ''}
      <div class="grid g2" style="margin-top:14px">
        <div class="card"><h2>${ov ? 'Daily views (28d, Analytics API)' : 'Subscriber snapshots (90d)'}</h2>${raw(ov ? lineChart([{ values: ov.daily.map(d => d.views) }], { labels: ov.daily.map(d => d.day) }) : lineChart([{ values: hist.map(x => x.subs) }], { labels: hist.map(x => x.day) }))}</div>
        <div class="card"><h2>Alerts <a href="#/competitors/alerts" class="mini">all</a></h2>${alerts.length ? alerts.slice(0, 8).map(a => h`<div class="check pass"><i>!</i><div>${a.title}<div class="d">${ago(a.created_at)}</div></div></div>`).join('') : h`<div class="muted">No unread alerts. Competitor uploads, breakouts and packaging changes land here after each daily snapshot.</div>`}</div>
      </div>
      <div class="grid g2" style="margin-top:14px">
        <div class="card"><h2>Breakouts (≥ 3× median)</h2>${seg.long.breakout.length ? seg.long.breakout.slice(0, 6).map(v => h`<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><a href="#" data-v="${v.id}" class="vlink" style="flex:1;min-width:0">${raw(videoCell(v))}</a><span class="badge x ok">${(v.view_count / seg.long.median).toFixed(1)}×</span></div>`).join('') : h`<div class="muted">No breakouts yet. Median long-form views: ${fmt(seg.long.median)}</div>`}</div>
        <div class="card"><h2>Latest uploads</h2>${lib.videos.map(v => h`<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><a href="#" data-v="${v.id}" class="vlink" style="flex:1;min-width:0">${raw(videoCell(v))}</a><span class="badge">${fmt(v.view_count)} views</span></div>`).join('') || h`<div class="muted">Sync to load videos.</div>`}</div>
      </div>`;
    main.querySelectorAll('.vlink').forEach(a => a.onclick = e => { e.preventDefault(); openVideo(a.dataset.v); });
    main.querySelector('#sync').onclick = async e => { busy(e.target, true); try { const r = await api(`/channels/${ch.id}/sync`, { method: 'POST', body: { force: true } }); toast(`Synced ${r.synced} videos`); await refreshChannels(); TD.route(); } catch (x) { err(x); } busy(e.target, false); };
  });

  view('/channels', async (main, r) => {
    const channels = await api('/channels');
    const owned = channels.filter(c => c.kind === 'owned'), comps = channels.filter(c => c.kind !== 'owned');
    const connected = r.query.connected ? r.query.connected.split(',') : [];
    const row = c => h`<tr><td><div class="vt"><img class="avatar" src="${c.thumbnail || ''}"><div><div class="t">${c.title}</div><div class="m">${c.handle || c.id}${c.oauth_email ? ' · ' + c.oauth_email : ''}</div></div></div></td>
      <td class="num">${fmtFull(c.subscriber_count)}</td><td class="num">${fmt(c.view_count)}</td><td class="num">${fmtFull(c.video_count)}</td><td>${ago(c.last_synced)}</td>
      <td>${c.kind === 'owned' ? (c.authorized ? h`<span class="badge ok">Google-connected</span>` : h`<span class="badge warn">public only</span>`) : h`<span class="badge">competitor</span>`}</td>
      <td class="row">${c.kind === 'owned' ? h`<button class="sm" data-use="${c.id}">Use</button><button class="sm" data-sync="${c.id}">Sync</button>${c.authorized ? h`<button class="sm ghost" data-disc="${c.id}">Disconnect</button>` : ''}<button class="sm ghost" data-kind="${c.id}" data-k="competitor">→ competitor</button>` : h`<button class="sm" data-kind="${c.id}" data-k="owned">Mark as owned</button>`}<button class="sm ghost" data-del="${c.id}">Remove</button></td></tr>`;
    main.innerHTML = h`
      <div class="page-head"><div><h1>Channels</h1><div class="sub">Each channel is its own workspace: data, boards, blueprints, competitors and alerts stay separate.</div></div></div>
      ${connected.length ? h`<div class="note ok" style="margin-bottom:14px">Connected ${connected.length} channel(s) with Google. Video libraries are syncing in the background.</div>` : ''}
      <div class="grid g2">
        <div class="card"><h2>Connect a channel you own</h2>
          <p class="mini">Google OAuth proves ownership and unlocks the Analytics API (retention, traffic sources, demographics, revenue), metadata edits, comment replies and caption downloads. Tokens are stored only in this app's local database.</p>
          <div class="row"><button id="oauth" class="primary">Connect with Google</button>${state.status?.configured?.oauth ? '' : h`<span class="mini">Add an OAuth client ID/secret in Settings first.</span>`}</div>
          <p class="mini" style="margin-top:12px">Google lets you pick one channel per sign-in (brand accounts appear in the account picker). Repeat Connect with Google for each channel you own.</p>
        </div>
        <div class="card"><h2>Add by ID, handle or URL</h2>
          <p class="mini">Works with the API key alone: public stats, uploads, outliers, comments (read), packaging checks. Choose "owned" for your channels to use them as workspaces without Google sign-in.</p>
          <div class="form"><input id="add-input" placeholder="UC…, @handle, channel URL or a video URL"><div class="row"><select id="add-kind"><option value="owned">Owned (workspace)</option><option value="competitor">Competitor (reference)</option></select><input id="add-max" type="number" value="200" min="50" max="2000" step="50" style="width:90px" title="videos to sync"><button id="add" class="primary">Add & sync</button></div></div>
        </div>
      </div>
      <div class="card" style="margin-top:14px"><h2>Owned channels (${owned.length})</h2>${owned.length ? h`<table><thead><tr><th>Channel</th><th class="num">Subs</th><th class="num">Views</th><th class="num">Videos</th><th>Synced</th><th>Status</th><th></th></tr></thead><tbody>${owned.map(row).join('')}</tbody></table>` : empty('No owned channels yet.')}</div>
      <div class="card" style="margin-top:14px"><h2>Reference channels (${comps.length})</h2>${comps.length ? h`<table><thead><tr><th>Channel</th><th class="num">Subs</th><th class="num">Views</th><th class="num">Videos</th><th>Synced</th><th>Status</th><th></th></tr></thead><tbody>${comps.map(row).join('')}</tbody></table>` : h`<div class="muted">Competitors you add under Competitors appear here too.</div>`}</div>`;
    main.querySelector('#oauth').onclick = async e => { try { const { url } = await api('/oauth/url'); location.href = url; } catch (x) { err(x); } };
    main.querySelector('#add').onclick = async e => {
      const input = main.querySelector('#add-input').value.trim(); if (!input) return;
      busy(e.target, true);
      try { const c = await api('/channels', { method: 'POST', body: { input, kind: main.querySelector('#add-kind').value, maxVideos: Number(main.querySelector('#add-max').value) } }); toast(`Added ${c.title}`, 'ok'); await refreshChannels(); if (c.kind === 'owned') TD.setCurrent(c.id); TD.route(); } catch (x) { err(x); }
      busy(e.target, false);
    };
    main.querySelectorAll('[data-use]').forEach(b => b.onclick = () => { TD.setCurrent(b.dataset.use); go('/'); });
    main.querySelectorAll('[data-sync]').forEach(b => b.onclick = async () => { busy(b, true); try { const r = await api(`/channels/${b.dataset.sync}/sync`, { method: 'POST', body: { force: true } }); toast(`Synced ${r.synced} videos, ${r.metadataChanges} metadata changes`); await refreshChannels(); TD.route(); } catch (x) { err(x); } busy(b, false); });
    main.querySelectorAll('[data-disc]').forEach(b => b.onclick = async () => { if (!confirm('Remove the stored Google tokens for this channel?')) return; await api(`/channels/${b.dataset.disc}/disconnect`, { method: 'POST' }); await refreshChannels(); TD.route(); });
    main.querySelectorAll('[data-kind]').forEach(b => b.onclick = async () => { await api(`/channels/${b.dataset.kind}/kind`, { method: 'POST', body: { kind: b.dataset.k } }); await refreshChannels(); TD.route(); });
    main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Remove this channel and all its local data (videos, snapshots, boards)?')) return; await api(`/channels/${b.dataset.del}`, { method: 'DELETE' }); await refreshChannels(); TD.route(); });
  });
})();
