/* Virality radar: pre-publish package scoring, calibration against the channel's own history, live breakout watch. */
(() => {
  const { view, api, h, raw, safe, esc, fmt, fmtFull, ago, date, videoCell, stat, empty, needOwned, scoreRing, err, toast, busy, state, openVideo, ls, lineChart, openDrawer, scoreClass } = TD;
  const TABS = [['score', 'Score an idea'], ['watch', 'Live watch'], ['calibration', 'Calibration'], ['history', 'History'], ['method', 'Method']];
  let AXES = null;
  const axesInfo = async () => AXES || (AXES = await api('/radar/axes'));

  view('/radar', async (main, r) => {
    const tab = r.path.split('/')[2] || 'score';
    main.innerHTML = h`<div class="page-head"><div><h1>Virality radar</h1><div class="sub">Score a package before you publish, calibrated to what actually moved views on this channel — then watch every new upload against its usual launch curve.</div></div></div>
      <div class="tabs">${TABS.map(([k, l]) => h`<a href="#/radar/${k}" class="${tab === k ? 'active' : ''}">${l}</a>`).join('')}</div><div id="body"></div>`;
    const body = main.querySelector('#body');
    await ({ score, watch, calibration, history, method }[tab] || score)(body, r);
  });

  // ---------- shared visuals ----------
  const ORDER = ['demand', 'patternFit', 'freshness', 'titleCraft', 'curiosity', 'emotion', 'thumbnail', 'hook'];
  const SHORT = { demand: 'Demand', patternFit: 'Pattern fit', freshness: 'Freshness', titleCraft: 'Title craft', curiosity: 'Curiosity', emotion: 'Emotion', thumbnail: 'Thumbnail', hook: 'Hook' };
  function radarSvg(series, { size = 280 } = {}) {
    const c = size / 2, R = size / 2 - 52, n = ORDER.length;
    const pt = (i, v) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; const rr = (R * Math.max(0, Math.min(100, v || 0))) / 100; return [c + rr * Math.cos(a), c + rr * Math.sin(a)]; };
    let s = `<svg class="radar-svg" viewBox="-40 0 ${size + 80} ${size}" width="100%" style="max-width:${size + 80}px">`;
    for (const ring of [25, 50, 75, 100]) s += `<polygon class="ring" points="${ORDER.map((_, i) => pt(i, ring).join(',')).join(' ')}"/>`;
    ORDER.forEach((k, i) => {
      const [x, y] = pt(i, 100); s += `<line class="spoke" x1="${c}" y1="${c}" x2="${x}" y2="${y}"/>`;
      const [lx, ly] = pt(i, 128); const missing = series.every(se => !Number.isFinite(se.axes[k]));
      const anchor = Math.abs(lx - c) < 6 ? 'middle' : lx > c ? 'start' : 'end';
      s += `<text x="${lx}" y="${ly + 3}" text-anchor="${anchor}" class="${missing ? 'na' : ''}">${esc(SHORT[k])}${missing ? ' —' : ''}</text>`;
    });
    series.forEach((se, si) => {
      const pts = ORDER.map((k, i) => pt(i, se.axes[k]).join(',')).join(' ');
      s += `<polygon class="shape s${si}" points="${pts}"/>`;
      ORDER.forEach((k, i) => { if (Number.isFinite(se.axes[k])) { const [x, y] = pt(i, se.axes[k]); s += `<circle class="dot s${si}" cx="${x}" cy="${y}" r="2.6"><title>${esc(SHORT[k])}: ${se.axes[k]}</title></circle>`; } });
    });
    return safe(s + '</svg>');
  }
  const bandClass = b => b === 'Breakout potential' ? 'ok' : b === 'Above baseline' ? 'info' : b === 'Typical' ? '' : 'warn';
  const statusClass = s => ({ breakout: 'ok', rising: 'info', 'on-track': '', lagging: 'warn', stalled: 'bad' }[s] || '');
  const xFmt = x => x === null || x === undefined ? '—' : (x >= 10 ? Math.round(x) : x.toFixed(x >= 1 ? 1 : 2)) + '×';
  const pctFmt = p => p === null || p === undefined ? '—' : Math.round(p * 100) + '%';
  function spark(points, { w = 110, hgt = 28 } = {}) {
    if (!points || points.length < 2) return safe('<span class="mini">—</span>');
    const minH = Math.min(...points.map(p => p.h)), maxH = Math.max(...points.map(p => p.h));
    const minV = Math.min(...points.map(p => p.v)), maxV = Math.max(...points.map(p => p.v));
    if (maxH - minH < 0.05) return safe('<span class="mini">1 reading</span>');
    const y = v => maxV === minV ? hgt / 2 : hgt - 2 - ((v - minV) / (maxV - minV)) * (hgt - 4);
    const d = points.map(p => `${((p.h - minH) / (maxH - minH)) * (w - 2) + 1},${y(p.v)}`).join(' ');
    return safe(`<svg width="${w}" height="${hgt}" class="spark"><polyline points="${d}"/></svg>`);
  }
  function scatter(points, { width = 560, height = 260 } = {}) {
    if (!points?.length) return empty('No calibration points yet.');
    const pad = { l: 44, r: 12, t: 10, b: 28 };
    const ys = points.map(p => Math.log2(Math.max(0.03, p.actualX)));
    const ymin = Math.min(-2, ...ys), ymax = Math.max(2, ...ys);
    const X = v => pad.l + (v / 100) * (width - pad.l - pad.r), Y = v => pad.t + (1 - (v - ymin) / (ymax - ymin)) * (height - pad.t - pad.b);
    let s = `<svg class="chart" viewBox="0 0 ${width} ${height}">`;
    for (let g = Math.ceil(ymin); g <= Math.floor(ymax); g++) s += `<line class="grid" x1="${pad.l}" x2="${width - pad.r}" y1="${Y(g)}" y2="${Y(g)}"/><text x="${pad.l - 4}" y="${Y(g) + 3}" text-anchor="end">${esc(xFmt(2 ** g))}</text>`;
    for (let v = 0; v <= 100; v += 25) s += `<text x="${X(v)}" y="${height - 8}" text-anchor="middle">${v}</text>`;
    s += `<line class="base" x1="${pad.l}" x2="${width - pad.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;
    points.forEach((p, i) => { s += `<circle class="pt ${p.own ? 'own' : ''}" cx="${X(p.score)}" cy="${Y(ys[i])}" r="3"><title>score ${p.score} → ${xFmt(p.actualX)}</title></circle>`; });
    return safe(s + `<text x="${width / 2}" y="${height}" text-anchor="middle" class="axis-t">radar score</text></svg>`);
  }

  // ---------- Score an idea ----------
  async function score(body) {
    const ch = state.current;
    const saved = ls('radar-form') || {};
    body.innerHTML = h`<div class="grid g2 radar-top">
      <div class="card"><h2>Package</h2><div class="form">
        <label class="f">Title variants — one per line (up to 8)<textarea id="titles" style="min-height:110px" placeholder="7 Medicaid Rules That Quietly Cost Families $100K&#10;The Medicaid Rule Nobody Explains (Until It's Too Late)">${saved.titles || ''}</textarea></label>
        <label class="f">Thumbnails (optional) — upload or paste image URLs, one per line<div class="row"><input type="file" id="tfile" accept="image/*" multiple style="display:none"><button id="tup" class="sm">Upload images</button><span class="mini" id="tcount"></span></div><textarea id="turls" class="mono" style="min-height:52px" placeholder="https://… or uploaded images appear here">${saved.turls || ''}</textarea></label>
        <div class="mini">1 thumbnail → tested with every title · several thumbnails + 1 title → thumbnail A/B · equal counts → paired · otherwise every combination (max 8).</div>
        <label class="f">Opening hook (optional) — first ~30 seconds of the script<textarea id="hook" style="min-height:70px">${saved.hook || ''}</textarea></label>
        <div class="form cols"><label class="f">Topic keyword<input id="kw" value="${saved.kw || ''}" placeholder="auto from the first title"></label>
          <label class="f">Format<select id="fmt"><option value="long" ${saved.fmt !== 'short' ? 'selected' : ''}>Long-form</option><option value="short" ${saved.fmt === 'short' ? 'selected' : ''}>Short</option></select></label></div>
        <div class="row"><label class="row mini"><input type="checkbox" id="useai" ${saved.ai === false ? '' : 'checked'}> AI axes (curiosity, emotion, thumbnail, hook)</label></div>
        <div class="row"><button id="go" class="primary">Run the radar</button>${ch ? h`<span class="mini">Scoring for ${ch.title}</span>` : h`<span class="mini">No channel selected — pattern fit & freshness need one.</span>`}</div>
      </div></div>
      <div class="card" id="model-card"><h2>Model</h2><div class="loading"><span class="spinner"></span></div></div>
    </div><div id="out" style="margin-top:14px"></div>`;
    const modelCard = body.querySelector('#model-card');
    if (ch) {
      api(`/radar/model/${ch.id}`).then(({ current: m }) => {
        const ho = m.metrics?.holdout;
        modelCard.innerHTML = h`<h2>Model <span class="badge ${m.calibrated ? 'ok' : 'warn'}">${m.calibrated ? 'calibrated' : 'default priors'}</span></h2>
          ${m.calibrated ? h`<div class="kv"><b>Calibrated</b><span>${ago(m.createdAt)} on ${fmtFull(m.nTrain)} videos</span><b>Holdout verdict</b><span><span class="badge ${ho?.verdict === 'useful' ? 'ok' : ho?.verdict === 'weak' ? 'warn' : 'bad'}">${ho?.verdict || 'n/a'}</span> ${ho?.available ? h`Spearman ${ho.spearman} · top-quartile hit rate ${pctFmt(ho.topQuartileHitRate)} vs ${pctFmt(ho.baseHitRate)} base` : ho?.reason || ''}</span></div>`
            : h`<p class="mini">Weights are generic priors until you calibrate. Calibration backtests the radar on your own library (plus tracked competitors) and learns which axes actually predicted views here.</p><a class="btn sm" href="#/radar/calibration">Calibrate now</a>`}
          <div style="margin-top:10px">${raw(TD.hbars(ORDER.map(k => ({ label: SHORT[k], value: m.weights[k] || 0 })), { format: v => Math.round(v * 100) + '%' }))}</div>`;
      }).catch(e => { modelCard.innerHTML = h`<div class="note bad">${e.message}</div>`; });
    } else modelCard.innerHTML = needOwned();

    const thumbs = () => body.querySelector('#turls').value.split('\n').map(s => s.trim()).filter(Boolean);
    const updCount = () => { const n = thumbs().length; body.querySelector('#tcount').textContent = n ? `${n} image${n > 1 ? 's' : ''}` : ''; };
    updCount(); body.querySelector('#turls').oninput = updCount;
    body.querySelector('#tup').onclick = () => body.querySelector('#tfile').click();
    body.querySelector('#tfile').onchange = async e => {
      const files = [...e.target.files]; if (!files.length) return;
      busy(body.querySelector('#tup'), true);
      try {
        for (const f of files) {
          const dataUrl = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
          const d = await api('/packaging/thumbnail/upload', { method: 'POST', body: { dataUrl, name: f.name } });
          const ta = body.querySelector('#turls'); ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + d.url;
        }
        updCount();
      } catch (x) { err(x); }
      busy(body.querySelector('#tup'), false); e.target.value = '';
    };

    body.querySelector('#go').onclick = async e => {
      const titles = body.querySelector('#titles').value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!titles.length) return toast('Add at least one title');
      const imgs = thumbs();
      let variants;
      const tv = u => /^\/data\/thumbs\//.test(u) ? { thumbnailUrl: u } : { thumbnailUrl: u };
      if (!imgs.length) variants = titles.map(t => ({ title: t }));
      else if (imgs.length === 1) variants = titles.map(t => ({ title: t, ...tv(imgs[0]) }));
      else if (titles.length === 1) variants = imgs.map(u => ({ title: titles[0], ...tv(u) }));
      else if (titles.length === imgs.length) variants = titles.map((t, i) => ({ title: t, ...tv(imgs[i]) }));
      else variants = titles.flatMap(t => imgs.map(u => ({ title: t, ...tv(u) })));
      if (variants.length > 8) { toast(`${variants.length} combinations — scoring the first 8`); variants = variants.slice(0, 8); }
      const payload = { channelId: ch?.id || null, variants, hook: body.querySelector('#hook').value.trim(), keyword: body.querySelector('#kw').value.trim(), format: body.querySelector('#fmt').value, ai: body.querySelector('#useai').checked };
      ls('radar-form', { titles: body.querySelector('#titles').value, turls: body.querySelector('#turls').value, hook: payload.hook, kw: payload.keyword, fmt: payload.format, ai: payload.ai });
      busy(e.target, true);
      const out = body.querySelector('#out');
      out.innerHTML = h`<div class="loading"><span class="spinner"></span> Scoring ${variants.length} package${variants.length > 1 ? 's' : ''}${payload.ai ? ' — AI rating can take a minute' : ''}…</div>`;
      try { renderResult(out, await api('/radar/score', { method: 'POST', body: payload })); } catch (x) { out.innerHTML = h`<div class="note bad">${x.message}</div>`; }
      busy(e.target, false);
    };
  }

  function renderResult(out, d) {
    const best = d.variants[0];
    const multi = d.variants.length > 1;
    out.innerHTML = h`
      ${d.notes.length ? h`<div class="stack" style="margin-bottom:12px">${d.notes.map(n => h`<div class="note warn">${n}</div>`).join('')}</div>` : ''}
      ${multi ? h`<div class="card" style="margin-bottom:14px"><h2>Ranking <span class="mini">keyword “${d.keyword}” · ${d.format}</span></h2><table><thead><tr><th>#</th><th>Package</th><th class="num">Score</th><th>Band</th><th class="num">Predicted</th><th class="num">P(≥2×)</th></tr></thead><tbody>
        ${d.variants.map(v => h`<tr><td class="rank">${v.rank}</td><td><div class="vt">${v.thumbnail ? h`<img class="thumb sm" src="${v.thumbnail}">` : ''}<div class="t">${v.title}</div></div></td><td class="num">${v.score ?? '—'}</td><td><span class="badge ${bandClass(v.prediction?.band)}">${v.prediction?.band || '—'}</span></td><td class="num">${xFmt(v.prediction?.multiplier)}</td><td class="num">${pctFmt(v.prediction?.pBreakout)}</td></tr>`).join('')}
        </tbody></table><div class="src">Ranking is decided by the composite score. If two packages are within ~5 points, the radar can't separate them — run YouTube's Test & Compare on those two.</div></div>` : ''}
      <div class="grid ${multi ? 'g2' : ''}">${d.variants.map(v => variantCard(v, d, v === best && multi)).join('')}</div>`;
    out.querySelectorAll('[data-v]').forEach(a => a.onclick = ev => { ev.preventDefault(); openVideo(a.dataset.v); });
  }

  function variantCard(v, d, isBest) {
    const p = v.prediction;
    const det = v.details || {};
    return h`<div class="card radar-card ${isBest ? 'best' : ''}">
      <div class="row between" style="align-items:flex-start"><div style="flex:1;min-width:0">${isBest ? h`<span class="badge ok">Top pick</span> ` : ''}<span class="rank">#${v.rank}</span><h2 style="margin:4px 0">${v.title}</h2></div>${v.score !== null ? scoreRing(v.score) : ''}</div>
      ${v.thumbnail ? h`<img src="${v.thumbnail}" class="radar-thumb">` : ''}
      <div class="radar-wrap">${radarSvg([{ axes: v.axes }])}
        <div class="stack" style="min-width:180px;flex:1">
          ${p ? h`<div><span class="badge ${bandClass(p.band)}">${p.band}</span></div>
          <div class="kv"><b>Predicted</b><span><b class="big">${xFmt(p.multiplier)}</b> your usual views</span><b>80% range</b><span>${xFmt(p.range80[0])} – ${xFmt(p.range80[1])}</span><b>P(breakout ≥2×)</b><span>${pctFmt(p.pBreakout)}</span><b>P(above usual)</b><span>${pctFmt(p.pAboveBaseline)}</span><b>Axes scored</b><span>${Math.round((v.coverage || 0) * 100)}% of model weight</span></div>` : empty('Not enough axes to score.')}
        </div></div>
      <table class="axes-t"><tbody>${ORDER.map(k => h`<tr><td>${SHORT[k]}</td><td class="num">${Number.isFinite(v.axes[k]) ? h`<span class="axv ${scoreClass(v.axes[k])}">${v.axes[k]}</span>` : h`<span class="muted">—</span>`}</td><td class="mini">${axisDetail(k, det[k], v)}</td></tr>`).join('')}</tbody></table>
      ${v.ai?.why ? h`<div class="note" style="margin-top:10px"><b>AI read:</b> ${v.ai.why}</div>` : ''}
      ${v.advice?.length ? h`<h3 style="margin-top:12px">Fix first</h3>${v.advice.map(a => h`<div class="check fail"><i>!</i><div><div><b>${a.label}</b> (${a.value})</div><div class="d">${a.text}</div></div></div>`).join('')}` : h`<div class="note ok" style="margin-top:10px">No axis below 55 — this package has no obvious weak spot.</div>`}
    </div>`;
  }
  function axisDetail(k, det, v) {
    if (k === 'demand' && det) return h`“${det.keyword}” · ${det.band} · in ${det.regionsPresent?.length ?? 0}/5 regions`;
    if (k === 'patternFit' && det) return h`${det.topicMultiplier !== null ? `similar topics ${xFmt(det.topicMultiplier)}` : 'no close topics'} · ${det.format} ${det.formatMultiplier !== null ? xFmt(det.formatMultiplier) : 'n/a'}${det.similar?.length ? h` · e.g. ${raw(det.similar.slice(0, 2).map(s => h`<a href="#" data-v="${s.id}">${s.title.slice(0, 40)}</a> ${xFmt(s.multiplier)}`).join(', '))}` : ''}`;
    if (k === 'freshness' && det) return det.ownDuplicate ? h`repeats your “${det.ownDuplicate.title.slice(0, 50)}”` : det.closest ? h`closest: “${det.closest.title.slice(0, 50)}” (${det.closest.channel}) · ${det.similarRecentUploads} similar in 90d` : h`nothing similar in ${det.uploadsChecked} recent uploads`;
    if (k === 'titleCraft') return det?.failed?.length ? h`fails: ${det.failed.slice(0, 2).join('; ')}` : 'passes the checklist';
    if (['curiosity', 'emotion'].includes(k)) return Number.isFinite(v.axes[k]) ? 'AI rating' : 'AI off';
    if (k === 'thumbnail') return Number.isFinite(v.axes[k]) ? 'AI vision rating' : v.thumbnail ? 'AI off' : 'no image given';
    if (k === 'hook') return Number.isFinite(v.axes[k]) ? 'AI rating of the opening' : 'no hook given';
    return '';
  }

  // ---------- Live watch ----------
  async function watch(body) {
    const ch = state.current; if (!ch) { body.innerHTML = needOwned(); return; }
    const d = await api(`/radar/watch/${ch.id}`);
    const own = d.videos.filter(v => v.kind === 'owned'), comp = d.videos.filter(v => v.kind !== 'owned');
    const table = list => list.length ? h`<table><thead><tr><th>Video</th><th class="num">Age</th><th class="num">Views</th><th class="num">Usual at this age</th><th class="num">Pace</th><th>Status</th><th class="num">Peak</th><th class="num">Retention</th><th>Curve</th></tr></thead><tbody>
      ${list.map(v => h`<tr class="clickable" data-curve="${v.video_id}"><td><div class="vt"><img class="thumb sm ${v.is_short ? 'v' : ''}" src="${v.thumbnail || ''}"><div><div class="t">${v.title}</div><div class="m">${v.kind === 'owned' ? '' : v.channel_title + ' · '}${v.active ? 'watching' : 'final reading'}</div></div></div></td>
        <td class="num">${v.age_hours === null ? '—' : v.age_hours < 48 ? Math.round(v.age_hours) + 'h' : (v.age_hours / 24).toFixed(1) + 'd'}</td><td class="num">${fmtFull(v.views)}</td><td class="num" title="${v.baseline_source || ''}">${v.expected === null ? '—' : fmtFull(Math.round(v.expected))}${v.confidence === 'low' ? h` <span class="badge warn" title="${v.baseline_source || ''}">est.</span>` : ''}</td>
        <td class="num"><span class="badge x ${v.idx >= 2 ? 'ok' : v.idx >= 1.3 ? 'info' : v.idx !== null && v.idx < 0.7 ? 'warn' : ''}">${xFmt(v.idx)}</span></td><td><span class="badge ${statusClass(v.status)}">${v.status || '—'}</span></td><td class="num">${xFmt(v.peak_idx)}</td>
        <td class="num">${v.retention_pct ? h`${v.retention_pct.toFixed(0)}%${v.retention_vs_channel ? h` <span class="mini">(${xFmt(v.retention_vs_channel)} avg)</span>` : ''}` : '—'}</td><td>${spark(v.spark)}</td></tr>`).join('')}</tbody></table>` : null;
    const lr = d.lastRun;
    body.innerHTML = h`<div class="row between" style="margin-bottom:12px"><div class="mini">${lr ? h`Last check ${ago(lr.at)} · ${lr.watched} videos · ${lr.channels} channels${lr.errors?.length ? h` · <span class="down">${lr.errors.length} error(s)</span>` : ''}` : 'Not run yet.'} Runs on its own every hour (≈2 quota units per channel).</div><button id="run" class="primary sm">Check now</button></div>
      ${lr?.errors?.length ? h`<div class="note bad" style="margin-bottom:12px">${lr.errors.join(' · ')}</div>` : ''}
      <div class="card"><h2>Your uploads</h2>${table(own) || empty('No uploads on the radar yet. Every new upload is picked up within the hour and compared with your usual launch curve.')}</div>
      <div class="card" style="margin-top:14px"><h2>Competitor uploads</h2>${table(comp) || empty('No recent competitor uploads. Track competitors under Competitors to catch their breakouts while they are still rising.')}</div>
      <div class="src">Pace = views now ÷ what your uploads usually have at the same age. Baselines come from hourly launch curves of earlier uploads once enough exist, otherwise from daily snapshots, otherwise an estimate (marked est., which needs ${'1.5×'} the breakout threshold before alerting). Breakout and lagging alerts land in Alerts.</div>`;
    body.querySelector('#run').onclick = async e => { busy(e.target, true); try { const r = await api('/radar/watch/run', { method: 'POST' }); toast(`Checked ${r.watched} videos${r.alerts.length ? `, ${r.alerts.length} alert(s)` : ''}`, 'ok'); await watch(body); } catch (x) { err(x); busy(e.target, false); } };
    body.querySelectorAll('[data-curve]').forEach(tr => tr.onclick = () => curveDrawer(tr.dataset.curve));
  }
  async function curveDrawer(id) {
    openDrawer('<div class="loading"><span class="spinner"></span></div>');
    try {
      const c = await api(`/radar/curve/${id}`);
      const t = c.ticks.map(x => ({ h: x.age_hours, v: x.views }));
      const at = hh => { const pts = [{ h: 0, v: 0 }, ...t]; for (let i = 1; i < pts.length; i++) if (hh <= pts[i].h) { const a = pts[i - 1], b = pts[i]; return a.v + (b.v - a.v) * ((hh - a.h) / ((b.h - a.h) || 1)); } return null; };
      const labels = c.expected.map(e => e.h < 48 ? Math.round(e.h) + 'h' : (e.h / 24).toFixed(1) + 'd');
      const v = c.video;
      document.getElementById('drawer-inner').innerHTML = h`<div class="drawer-head"><div><h2>${v.title}</h2><div class="mini">${v.kind === 'owned' ? 'Your upload' : 'Competitor upload'} · published ${date(v.published_at)} · ${fmtFull(v.views)} views</div></div><button onclick="TD.closeDrawer()">Close</button></div>
        <div class="grid g4">${raw(stat('Pace now', xFmt(v.idx)))}${raw(stat('Peak pace', xFmt(v.peak_idx)))}${raw(stat('Status', esc(v.status || '—')))}${raw(stat('Likes / comments', `${fmt(v.likes)} / ${fmt(v.comments)}`))}</div>
        <div class="card" style="margin-top:14px"><h2>Launch curve vs usual <span class="mini"><span class="lg b"></span> this video <span class="lg a"></span> usual at same age</span></h2>${raw(lineChart([{ values: c.expected.map(e => at(e.h)) }, { values: c.expected.map(e => e.v), cls: 'b' }], { labels: labels.map(l => '00000' + l), fill: false }))}<div class="src">Baseline: ${v.baseline_source || 'n/a'} (${v.confidence || 'n/a'} confidence).</div></div>
        <div class="row" style="margin-top:12px"><a class="btn" href="https://www.youtube.com/watch?v=${v.video_id}" target="_blank" rel="noopener">Open on YouTube</a>${v.kind === 'owned' ? h`<a class="btn" href="#/packaging/thumbnail" onclick="TD.closeDrawer()">Swap thumbnail</a><a class="btn" href="#/packaging/staged" onclick="TD.closeDrawer()">Stage a new title</a>` : h`<a class="btn" href="#/radar/score" onclick="TD.closeDrawer()">Score a response idea</a>`}</div>`;
    } catch (x) { document.getElementById('drawer-inner').innerHTML = h`<div class="note bad">${x.message}</div>`; }
  }

  // ---------- Calibration ----------
  async function calibration(body) {
    const ch = state.current; if (!ch) { body.innerHTML = needOwned(); return; }
    const [{ current: m, history: hist }, info] = await Promise.all([api(`/radar/model/${ch.id}`), axesInfo()]);
    const ho = m.metrics?.holdout;
    const saved = ls('radar-cal') || {};
    body.innerHTML = h`<div class="grid g2">
      <div class="card"><h2>Run calibration</h2>
        <p class="mini">Backtests the radar on ${ch.title}'s synced library plus tracked competitors. Each video's outcome is its views ÷ the median of its 10 nearest-in-time uploads (so channel growth doesn't count as success). Pattern fit and freshness only see videos published earlier. Then a time-ordered holdout fits on the oldest 70% and grades predictions on the newest 30%.</p>
        <div class="form cols"><label class="f">AI-rate up to N videos<input id="ailimit" type="number" min="0" max="400" value="${saved.aiLimit ?? 60}"></label><label class="f">Min. video age (days)<input id="minage" type="number" min="3" max="120" value="${saved.minAge ?? 14}"></label></div>
        <div class="row" style="margin-top:8px"><label class="row mini"><input type="checkbox" id="calai" ${saved.ai === false ? '' : 'checked'}> AI axes (cached per video; only new videos cost a call — ~6 per call)</label></div>
        <div class="row" style="margin-top:10px"><button id="cal" class="primary">Calibrate on my history</button></div>
        <div id="cal-prog" style="margin-top:10px"></div>
      </div>
      <div class="card"><h2>Current model <span class="badge ${m.calibrated ? 'ok' : 'warn'}">${m.calibrated ? 'calibrated ' + ago(m.createdAt) : 'default priors'}</span></h2>
        ${m.calibrated && ho ? (ho.available ? h`<div class="grid g2">${raw(stat('Rank accuracy (Spearman)', ho.spearman ?? '—', h`<span class="badge ${ho.verdict === 'useful' ? 'ok' : ho.verdict === 'weak' ? 'warn' : 'bad'}">${ho.verdict}</span>`))}${raw(stat('Top-quartile hit rate', pctFmt(ho.topQuartileHitRate), h`<span class="muted">vs ${pctFmt(ho.baseHitRate)} base · lift ${ho.lift ?? '—'}×</span>`))}${raw(stat('Top vs bottom quartile', xFmt(ho.topVsBottomMedianX), h`<span class="muted">median outcome ratio</span>`))}${raw(stat('Breakouts caught', `${ho.breakoutsInTopHalf}/${ho.breakoutsInTest}`, h`<span class="muted">≥2× videos ranked in the top half</span>`))}</div>
          <div class="src">Holdout: trained on ${ho.train} older videos, tested on ${ho.test} newer ones. Error ${ho.maeLog2} vs ${ho.maeNaiveLog2} (log₂ units) for always guessing the average.</div>` : h`<div class="note warn">${ho.reason}</div>`)
          : h`<p class="mini">No calibration yet. Until then the radar uses generic prior weights and a default score → multiplier map.</p>`}
        ${m.metrics?.noSignal ? h`<div class="note warn" style="margin-top:8px">No axis correlated positively with outcomes on this history — weights stay at their priors. More videos (or more AI-rated ones) usually fixes this.</div>` : ''}
        ${m.calibrated ? h`<div class="src">Sample: ${m.metrics.sample.labelled} videos (${m.metrics.sample.own} yours, ${m.metrics.sample.competitors} competitors), ${m.metrics.sample.withAI} with AI axes.${m.metrics.ai?.errors?.length ? ' AI errors: ' + m.metrics.ai.errors.join('; ') : ''}</div>` : ''}
      </div></div>
      <div class="grid g2" style="margin-top:14px">
        <div class="card"><h2>Weights</h2><table><thead><tr><th>Axis</th><th class="num">Prior</th><th class="num">Calibrated</th><th class="num">ρ with outcome</th><th class="num">n</th></tr></thead><tbody>
          ${ORDER.map(k => { const a = m.axes?.[k]; return h`<tr><td>${info.axes[k].label}</td><td class="num">${Math.round(info.defaultWeights[k] * 100)}%</td><td class="num"><b>${Math.round((m.weights[k] || 0) * 100)}%</b></td><td class="num">${a?.rho ?? (info.axes[k].backtest ? '—' : h`<span class="mini">live-only</span>`)}</td><td class="num">${a?.n || '—'}</td></tr>`; }).join('')}
        </tbody></table><div class="src">Weight = blend of the axis's share of positive correlation and its prior, trusting data more as n grows (λ = n ÷ (n + 40)). Score → multiplier: 2^(${m.map.alpha} + ${m.map.beta}·(score−50)/50), spread σ = ${m.map.sigma} log₂ units${m.map.slopeWasNegative ? ' (fitted slope was negative and was clamped to 0 — the composite did not predict outcomes)' : ''}.</div></div>
        <div class="card"><h2>Score vs actual outcome</h2>${raw(scatter(m.metrics?.points))}<div class="src"><span class="lg a"></span> your videos <span class="lg c"></span> competitors. Upward slope = the radar ranks winners higher. In-sample: the holdout numbers above are the honest ones.</div></div>
      </div>
      ${hist.length > 1 ? h`<div class="card" style="margin-top:14px"><h2>Calibration history</h2><table><thead><tr><th>When</th><th class="num">Videos</th><th class="num">Spearman</th><th>Verdict</th></tr></thead><tbody>${hist.map(x => h`<tr><td>${ago(x.createdAt)}</td><td class="num">${x.nTrain}</td><td class="num">${x.metrics?.holdout?.spearman ?? '—'}</td><td>${x.metrics?.holdout?.verdict || '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    body.querySelector('#cal').onclick = async e => {
      const opts = { ai: body.querySelector('#calai').checked, aiLimit: Number(body.querySelector('#ailimit').value), minAgeDays: Number(body.querySelector('#minage').value) };
      ls('radar-cal', { ai: opts.ai, aiLimit: opts.aiLimit, minAge: opts.minAgeDays });
      busy(e.target, true);
      const prog = body.querySelector('#cal-prog');
      try {
        let job = await api(`/radar/calibrate/${ch.id}`, { method: 'POST', body: opts });
        while (job.status === 'running') {
          const p = job.progress || {};
          prog.innerHTML = h`<div class="mini">${p.stage === 'ai' ? `AI-rating packages: ${p.done || 0}/${p.total || '?'}${p.failed ? ` (${p.failed} failed)` : ''}` : p.stage === 'fit' ? 'Fitting weights…' : 'Computing pattern fit and freshness…'}</div><div class="progress"><i style="width:${p.total ? Math.round(100 * (p.done || 0) / p.total) : 5}%"></i></div>`;
          await new Promise(r => setTimeout(r, 1500));
          job = await api(`/radar/jobs/${job.id}`);
        }
        if (job.status === 'failed') throw new Error(job.error);
        toast('Calibrated', 'ok'); await calibration(body);
      } catch (x) { prog.innerHTML = h`<div class="note bad">${x.message}</div>`; busy(e.target, false); }
    };
  }

  // ---------- History ----------
  async function history(body) {
    const ch = state.current; if (!ch) { body.innerHTML = needOwned(); return; }
    const [d, lib] = await Promise.all([api(`/radar/history/${ch.id}`), api(`/channels/${ch.id}/videos?limit=40`)]);
    if (!d.scores.length) { body.innerHTML = empty('Nothing scored yet.', h`<br><a href="#/radar/score">Score your next idea</a> — when it goes live, the radar links it to the upload automatically (matching title) and tracks how the prediction held up.`); return; }
    body.innerHTML = h`<div class="row" style="margin-bottom:12px">${raw(stat('Scored packages', d.scores.length))}${raw(stat('Linked to uploads', d.tracked.linked))}${raw(stat('With a final outcome', d.tracked.withOutcome))}${raw(stat('Prediction accuracy (Spearman)', d.tracked.spearman ?? '—', h`<span class="muted">needs ≥ 5 outcomes</span>`))}</div>
      <div class="card"><table><thead><tr><th>Scored</th><th>Package</th><th class="num">Score</th><th>Band</th><th class="num">Predicted</th><th>Upload</th><th class="num">Live pace</th><th class="num">Actual</th></tr></thead><tbody>
      ${d.scores.map(s => h`<tr><td class="mini">${ago(s.createdAt)}<br>${s.rank > 1 ? h`variant #${s.rank}` : 'top pick'}</td><td><div class="vt">${s.thumbnail ? h`<img class="thumb sm" src="${s.thumbnail}">` : ''}<div class="t">${s.title}</div></div></td><td class="num">${s.score ?? '—'}</td><td><span class="badge ${bandClass(s.band)}">${s.band || '—'}</span></td><td class="num">${xFmt(s.predictedX)}</td>
        <td>${s.videoId ? h`<a href="#" data-v="${s.videoId}">open</a> <button class="sm ghost" data-unlink="${s.id}">unlink</button>` : h`<select class="sm" data-link="${s.id}"><option value="">link to upload…</option>${lib.videos.map(v => h`<option value="${v.id}">${v.title.slice(0, 60)}</option>`).join('')}</select>`}</td>
        <td class="num">${s.live ? h`${xFmt(s.live.index)} <span class="badge ${statusClass(s.live.status)}">${s.live.status}</span>` : '—'}</td><td class="num">${s.actualX !== null ? h`<b>${xFmt(s.actualX)}</b>` : s.videoId ? h`<span class="mini">matures at 14d</span>` : '—'}</td></tr>`).join('')}
      </tbody></table><div class="src">Actual = views ÷ the median of the 10 nearest-in-time same-format uploads, once the video is old enough to judge.</div></div>`;
    body.querySelectorAll('[data-v]').forEach(a => a.onclick = e => { e.preventDefault(); openVideo(a.dataset.v); });
    body.querySelectorAll('[data-link]').forEach(s => s.onchange = async () => { if (!s.value) return; await api(`/radar/scores/${s.dataset.link}/link`, { method: 'POST', body: { videoId: s.value } }); toast('Linked', 'ok'); history(body); });
    body.querySelectorAll('[data-unlink]').forEach(b => b.onclick = async () => { await api(`/radar/scores/${b.dataset.unlink}/link`, { method: 'POST', body: { videoId: null } }); history(body); });
  }

  // Radar tab inside the shared video drawer (Library, Dashboard, Outliers…).
  TD.radarPanel = async videoId => {
    try {
      const r = await api(`/radar/video/${videoId}`);
      const p = r.prediction;
      return h`<div class="radar-wrap">${radarSvg([{ axes: r.axes }])}<div class="stack" style="flex:1;min-width:200px">
        <div class="row">${r.score !== null ? scoreRing(r.score) : ''}<div><b>Radar score at publish</b><div class="mini">${Math.round((r.coverage || 0) * 100)}% of model weight scored</div></div></div>
        <div class="kv"><b>Radar expected</b><span>${p ? xFmt(p.multiplier) + ' (' + p.band + ')' : '—'}</span><b>Actual</b><span>${r.actualX !== null ? h`<b>${xFmt(r.actualX)}</b> of its local baseline (${fmtFull(Math.round(r.baseline))} views)` : 'too young to judge (14 days)'}</span></div>
        ${r.ai?.why ? h`<div class="note">${r.ai.why}</div>` : ''}
        <table class="axes-t"><tbody>${ORDER.map(k => h`<tr><td>${SHORT[k]}</td><td class="num">${Number.isFinite(r.axes[k]) ? h`<span class="axv ${scoreClass(r.axes[k])}">${r.axes[k]}</span>` : h`<span class="muted">—</span>`}</td></tr>`).join('')}</tbody></table>
        <div class="src">${r.note}</div></div></div>`;
    } catch (e) { return h`<div class="note bad">${e.message}</div>`; }
  };

  // ---------- Method ----------
  async function method(body) {
    const info = await axesInfo();
    body.innerHTML = h`<div class="grid g2"><div class="card"><h2>The 8 axes</h2>${ORDER.map(k => h`<div class="step"><div class="n">${Math.round(info.defaultWeights[k] * 100)}</div><div><b>${info.axes[k].label}</b> <span class="badge">${info.axes[k].source}</span>${info.axes[k].backtest ? '' : h` <span class="badge warn">not backtested</span>`}<div class="mini">${info.axes[k].desc}</div></div></div>`).join('')}<div class="src">Numbers in circles are the default prior weights (%). Calibration replaces them with weights learned from your history.</div></div>
      <div class="card"><h2>How the prediction works</h2><div class="stack mini" style="font-size:13px;color:var(--fg2)">
        <div>${info.method}</div>
        <div><b>What it can't know:</b> YouTube's distribution decisions, timing luck, and what your thumbnail looked like when an old video launched (backtests use the current one). That is why every prediction is a range and why the calibration screen grades itself on newer videos it never saw.</div>
        <div><b>Live watch:</b> every hour it re-reads views of uploads younger than 7 days (competitors: 3 days) and compares them with your usual views at the same age. ≥ 2× usual pace = breakout alert (act while it's hot: Shorts, pinned comment, follow-up). ≤ 0.6× after 24 h = lagging alert (swap title/thumbnail — the fastest lever in the first days).</div>
        <div><b>Cost:</b> free. ~2 YouTube API units per channel per hour; AI calls run on your Claude Code subscription (or API key) and AI ratings are cached per video.</div>
      </div></div></div>`;
  }
})();
