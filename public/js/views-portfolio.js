/* All channels on one board: growth this week, latest upload pace, CTR, monetization progress, alerts, autopilot,
   top idea, Shorts; plus Instagram. The same data goes out as a weekly summary every Monday. */
(() => {
  const { view, api, h, raw, fmt, fmtFull, empty, stat, toast, err, busy, scoreRing } = TD;
  const pct = c => c === null || c === undefined ? '' : `${c >= 0 ? '+' : ''}${Math.round(c * 100)}%`;
  const x = v => v === null || v === undefined ? '—' : (v >= 10 ? Math.round(v) : v.toFixed(v >= 1 ? 1 : 2)) + '×';
  const statusClass = s => ({ breakout: 'ok', rising: 'info', 'on-track': '', lagging: 'warn', stalled: 'bad' }[s] || '');
  const bar = (p, label) => h`<div class="mini">${label} · ${Math.round((p || 0) * 100)}%</div><div class="pf-bar"><i style="width:${Math.round(Math.min(1, p || 0) * 100)}%"></i></div>`;

  view('/portfolio', async main => {
    main.innerHTML = h`<div class="page-head"><div><h1>All channels</h1><div class="sub">Every channel you own on one board — this week vs last, the latest upload's pace, CTR, monetization progress and what the autopilot did. A summary of this goes to your phone every Monday morning.</div></div><button id="weekly" class="sm">Send weekly summary now</button></div><div id="pf"><div class="loading"><span class="spinner"></span></div></div>`;
    main.querySelector('#weekly').onclick = async e => { busy(e.target, true); try { const r = await api('/portfolio/weekly-summary', { method: 'POST', body: { send: true } }); toast(r.sent?.sent?.length ? `Sent via ${r.sent.sent.join(' + ')}` : r.sent?.skipped ? `Not sent: ${r.sent.skipped} (Virality radar → Autopilot → Phone alerts)` : 'Summary built', 'ok'); } catch (x2) { err(x2); } busy(e.target, false); };
    let o;
    try { o = await api('/portfolio'); } catch (e) { main.querySelector('#pf').innerHTML = h`<div class="note bad">${e.message}</div>`; return; }
    if (!o.channels.length) { main.querySelector('#pf').innerHTML = empty('No owned channels yet.', h`<br><a href="#/channels">Add your channels</a>`); return; }
    main.querySelector('#pf').innerHTML = h`<div class="grid g4" style="margin-bottom:14px">${raw(stat('Channels', o.channels.length))}${raw(stat('Subscribers', fmt(o.totals.subscribers)))}${raw(stat('Views this week', o.totals.views7 === null ? '—' : fmt(o.totals.views7)))}${raw(stat('Open alerts', o.totals.alertsOpen))}</div>
      <div class="pf-grid">${o.channels.map(card).join('')}${o.instagram ? igCard(o.instagram) : ''}</div>
      <div class="src">Week-over-week growth comes from TubeDesk's daily snapshots (it needs two weeks of snapshots to compare). Monetization progress needs the channel connected with Google.</div>`;
  });

  function card(c) {
    const ap = c.autopilot7 || {};
    const apN = (ap.applied || 0) + (ap.kept || 0) + (ap.reverted || 0);
    return h`<div class="card pf-card"><div class="pf-head">${c.thumbnail ? h`<img src="${c.thumbnail}">` : ''}<div style="min-width:0"><h2 style="margin:0">${c.title}</h2><div class="mini">${fmt(c.subscribers)} subs · ${c.videoCount ?? '—'} videos${c.authorized ? '' : ' · not connected with Google'}</div></div></div>
      <div class="kv"><b>Views this week</b><span>${c.views7 === null ? h`<span class="mini">needs a week of snapshots</span>` : h`${fmtFull(c.views7)} <span class="${c.views7Change >= 0 ? 'up' : 'down'}">${pct(c.views7Change)}</span>`}</span>
        <b>Subs this week</b><span>${c.subs7 === null ? '—' : (c.subs7 >= 0 ? '+' : '') + fmtFull(c.subs7)}</span>
        <b>Uploads (30 d)</b><span>${c.uploads30}</span>
        <b>Latest upload</b><span>${c.latest ? h`${c.latest.title.slice(0, 48)} ${c.latest.status ? h`<span class="badge ${statusClass(c.latest.status)}">${c.latest.status} ${x(c.latest.pace)}</span>` : ''}` : '—'}</span>
        <b>CTR (28 d)</b><span>${c.ctr28 !== null && c.ctr28 !== undefined ? c.ctr28.toFixed(2) + '%' : h`<span class="mini">${c.ctrStatus.replace(/-/g, ' ')}</span>`}</span>
        <b>Open alerts</b><span>${c.alertsOpen}</span>
        <b>Autopilot (7 d)</b><span>${apN ? `${apN} change${apN > 1 ? 's' : ''}${ap.reverted ? `, ${ap.reverted} reverted` : ''}` : 'no changes'}${ap.suggested ? h` · <a href="#/radar/autopilot">${ap.suggested} to approve</a>` : ''}</span>
        <b>Shorts</b><span>${c.shorts.queued} queued · ${c.shorts.published7} posted this week</span>
        <b>Radar</b><span>${c.radar.calibrated ? c.radar.verdict || 'calibrated' : 'not calibrated'}</span></div>
      ${c.ypp ? h`<div style="margin-top:10px">${bar(c.ypp.watchHoursPct, `Watch hours ${fmtFull(c.ypp.watchHours)} / 4,000`)}${bar(c.ypp.subsPct, `Subscribers ${fmtFull(c.ypp.subs)} / 1,000`)}</div>` : ''}
      ${c.topIdea ? h`<div class="note" style="margin-top:10px"><b>Top idea:</b> ${c.topIdea.best_title} <span class="mini">(radar ${c.topIdea.score ?? '—'})</span></div>` : ''}
      ${c.topGainers.length ? h`<div class="mini" style="margin-top:8px"><b>Most views this week:</b> ${c.topGainers.map(v => h`${v.title.slice(0, 40)} (+${fmt(v.gained)})`).join(' · ')}</div>` : ''}
    </div>`;
  }
  function igCard(i) {
    return h`<div class="card pf-card"><div class="pf-head"><div><h2 style="margin:0">Instagram${i.username ? ' @' + i.username : ''}</h2><div class="mini">Reels</div></div></div>
      <div class="kv"><b>Reels this week</b><span>${i.reels7}</span><b>Views this week</b><span>${fmtFull(i.views7)}</span>
        <b>Latest reel</b><span>${i.latestStatus ? h`<span class="badge ${statusClass(i.latestStatus)}">${i.latestStatus} ${x(i.latestPace)}</span>` : '—'}</span>
        <b>Best this week</b><span>${i.best ? h`<a href="${i.best.permalink}" target="_blank" rel="noopener">${i.best.caption || 'reel'}</a> · ${fmtFull(i.best.views)}` : '—'}</span></div></div>`;
  }
})();
