/* Studio: ElevenLabs voiceover → timeline, thumbnail maker, similar channels */
(() => {
  const { view, api, h, raw, fmt, fmtFull, err, toast, busy, state, stat } = TD;

  view('/studio', async (main, r) => {
    const tab = r.path.split('/')[2] || 'voice';
    const [vs, ts] = await Promise.all([api('/media/voiceover/status'), api('/media/thumbnails/status')]);
    main.innerHTML = h`<div class="page-head"><div><h1>Studio</h1><div class="sub">The pieces vidIQ sells as "AI tools", running on your own keys: a voiceover with word timings that drops straight into the render pipeline, a thumbnail maker ranked by the critic, and channels like yours.</div></div></div>
      <div class="tabs">${[['voice', 'Voiceover'], ['thumbs', 'Thumbnail maker'], ['similar', 'Similar channels']].map(([k, l]) => h`<a href="#/studio/${k}" class="${tab === k ? 'active' : ''}">${l}</a>`).join('')}</div>
      <div id="body"></div>`;
    const body = main.querySelector('#body');

    if (tab === 'voice') {
      body.innerHTML = h`${vs.configured ? '' : h`<div class="note bad" style="margin-bottom:12px">ElevenLabs is not configured — paste your API key in Settings → Voiceover.</div>`}
        <div class="grid g2"><div class="card"><h2>Script → voiceover</h2>
          <textarea id="text" style="min-height:160px" placeholder="One scene per request (≤ 5,000 characters). Punctuation drives the pacing."></textarea>
          <div class="row" style="margin-top:8px"><input id="voice" placeholder="voice ID (blank = ${vs.voice_id})" style="flex:1"><input id="speed" type="number" step="0.05" min="0.7" max="1.2" value="1" style="width:80px" title="speed"><button id="go" class="primary">Generate</button></div>
          <div class="mini" style="margin-top:6px">Returns an MP3 plus every word's start/end from ElevenLabs' alignment — captions in the renderer line up with the voice without pause detection.</div></div>
        <div class="card"><h2>Script → ready Short</h2>
          <textarea id="text2" style="min-height:90px" placeholder="Script"></textarea>
          <label class="f">Background video or image (absolute path on this Mac)<input id="bg" placeholder="/Users/you/Movies/screen-recording.mp4"></label>
          <div class="grid g2"><label class="f">Headline (first 3.5s, optional)<input id="headline" placeholder="FREE VIDIQ"></label><label class="f">Music bed (optional path)<input id="music" placeholder="/path/bed.mp3"></label></div>
          <div class="row"><button id="go2" class="primary">Voice + render 9:16</button><span class="mini">Voiceover → timeline → MP4 in one step; the timeline is shown so an agent can tweak and re-render.</span></div></div></div>
        <div id="out" style="margin-top:12px"></div>
        <div class="card" style="margin-top:12px"><h2>Recent voiceovers</h2><div id="list"><div class="loading"><span class="spinner"></span></div></div></div>`;
      const list = async () => { const rows = await api('/media/voiceover'); body.querySelector('#list').innerHTML = rows.length ? h`<table><thead><tr><th>When</th><th>Text</th><th class="num">Duration</th><th class="num">Chars</th><th>File</th></tr></thead><tbody>${rows.map(v => h`<tr><td>${v.created_at.slice(5, 16)}</td><td>${v.text.slice(0, 90)}${v.text.length > 90 ? '…' : ''}</td><td class="num">${v.duration ? v.duration.toFixed(1) + 's' : '—'}</td><td class="num">${fmtFull(v.chars)}</td><td><code>${v.file}</code></td></tr>`).join('')}</tbody></table>` : h`<div class="muted">None yet.</div>`; };
      list();
      body.querySelector('#go').onclick = async e => {
        const text = body.querySelector('#text').value.trim(); if (!text) return;
        busy(e.target, true); const out = body.querySelector('#out');
        try {
          const v = await api('/media/voiceover', { method: 'POST', body: { text, voiceId: body.querySelector('#voice').value.trim() || undefined, speed: Number(body.querySelector('#speed').value) || 1 } });
          out.innerHTML = h`<div class="card"><div class="grid g4">${raw(stat('Duration', v.duration.toFixed(1) + 's'))}${raw(stat('Words', v.words.length))}${raw(stat('Caption groups', v.groups.length))}${raw(stat('Characters', fmtFull(v.chars)))}</div>
            <div class="mini" style="margin-top:8px">File: <code>${v.file}</code></div><audio controls src="/data/voiceovers/${v.file.split('/').pop()}" style="width:100%;margin-top:8px"></audio>
            <details style="margin-top:8px"><summary class="mini">Captions track (paste into a timeline)</summary><pre class="mini" style="white-space:pre-wrap">${JSON.stringify({ type: 'captions', groups: v.groups, y: 1180, size: 58, font: 'bold' })}</pre></details></div>`;
          list();
        } catch (x) { out.innerHTML = h`<div class="note bad">${x.message}</div>`; }
        busy(e.target, false);
      };
      body.querySelector('#go2').onclick = async e => {
        const text = body.querySelector('#text2').value.trim(), background = body.querySelector('#bg').value.trim(); if (!text || !background) return toast('Script and background are required');
        busy(e.target, true); const out = body.querySelector('#out'); out.innerHTML = h`<div class="loading"><span class="spinner"></span> Voice, then render — usually under a minute…</div>`;
        try {
          const o = await api('/media/voiceover/short?wait=1', { method: 'POST', body: { text, background, headline: body.querySelector('#headline').value.trim() || undefined, music: body.querySelector('#music').value.trim() || undefined, render: true } });
          const j = o.job;
          out.innerHTML = h`<div class="card"><h3>${j?.status === 'done' ? '✓ Rendered' : j?.status === 'failed' ? '✕ Render failed' : 'Render ' + (j?.status || 'queued')}</h3>
            ${j?.output ? h`<div class="mini">Output: <code>${j.output}</code></div><video controls src="/data/renders/${j.output.split('/').pop()}" style="max-height:480px;margin-top:8px;border-radius:8px"></video>` : ''}
            ${j?.error ? h`<div class="note bad">${j.error}</div>` : ''}
            <details style="margin-top:8px"><summary class="mini">Timeline JSON (edit and POST /api/render)</summary><pre class="mini" style="white-space:pre-wrap">${JSON.stringify(o.timeline, null, 1)}</pre></details>
            <div class="row" style="margin-top:8px"><a class="btn sm" href="#/radar">Score the title</a><span class="mini">Then publish via the publish API or an agent (publish_youtube / publish_instagram / publish_tiktok).</span></div></div>`;
          list();
        } catch (x) { out.innerHTML = h`<div class="note bad">${x.message}</div>`; }
        busy(e.target, false);
      };
    } else if (tab === 'thumbs') {
      body.innerHTML = h`${ts.ffmpeg ? '' : h`<div class="note bad" style="margin-bottom:12px">ffmpeg not found — install it (brew install ffmpeg) or set ffmpeg_path in Settings.</div>`}
        <div class="card"><h2>Make candidates</h2>
          <label class="f">Video file (absolute path)<input id="file" placeholder="/Users/you/Movies/final.mp4"></label>
          <label class="f">Video title (for scoring)<input id="title" placeholder="I cloned vidIQ for free"></label>
          <label class="f">Headlines, one per line (use | for a line break; ≤ 3)<textarea id="heads" style="min-height:70px" placeholder="FREE VIDIQ|AT HOME&#10;I CLONED IT&#10;$0 / MONTH"></textarea></label>
          <div class="row"><label class="row mini">Styles: ${Object.entries(ts.styles).map(([k, d]) => h`<label title="${d}"><input type="checkbox" class="st" value="${k}" ${k === 'bold' || k === 'contrast' ? 'checked' : ''}> ${k}</label>`).join(' ')}</label><label class="mini">Frames <input id="frames" type="number" value="3" min="1" max="6" style="width:60px"></label></div>
          <label class="f">AI background prompt (optional${ts.higgsfield ? '' : ' — needs Higgsfield key+secret in Settings'})<input id="ai" placeholder="a Mac Mini on a desk glowing red, dramatic rim light" ${ts.higgsfield ? '' : 'disabled'}></label>
          <div class="row"><button id="go" class="primary">Build & rank</button><span class="mini">Frames × headlines × styles, capped at 12. Scoring uses the thumbnail critic when AI is available, otherwise a heuristic.</span></div></div>
        <div id="out" style="margin-top:12px"></div>
        <div class="card" style="margin-top:12px"><h2>Recent sets</h2><div id="sets"></div></div>`;
      const show = s => {
        body.querySelector('#out').innerHTML = h`<div class="card"><h3>${s.title || 'Candidates'} — ${s.candidates.length} ranked</h3>${s.notes?.length ? h`<div class="mini">${s.notes.join(' · ')}</div>` : ''}
          <div class="grid g3" style="margin-top:10px">${s.candidates.map((c, i) => h`<div class="card tight"><img src="/data/thumbs/maker/${c.file.split('/maker/')[1]}" style="width:100%;border-radius:8px;aspect-ratio:16/9;object-fit:cover"><div class="row" style="justify-content:space-between;margin-top:6px"><b>${c.score ?? '—'}/100</b><span class="mini">${c.style} · ${c.source}${c.at != null ? ' @' + c.at + 's' : ''}</span></div><div class="mini">${c.headline}</div>${c.critique?.weaknesses?.length ? h`<div class="mini muted">${c.critique.weaknesses.slice(0, 2).join(' · ')}</div>` : ''}<div class="row" style="margin-top:6px"><button class="sm" data-copy="${c.file}">Copy path</button><a class="btn sm" href="/data/thumbs/maker/${c.file.split('/maker/')[1]}" download>Download</a></div></div>`).join('')}</div></div>`;
        body.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy); toast('Path copied — use it as "thumbnail" when publishing', 'ok'); });
      };
      const sets = async () => { const rows = await api('/media/thumbnails'); body.querySelector('#sets').innerHTML = rows.length ? h`<div class="row" style="flex-wrap:wrap">${rows.map(s => h`<button class="sm" data-set="${s.id}">${s.created_at.slice(5, 16)} · ${s.title || s.source?.split('/').pop() || s.id} (${s.n})</button>`).join('')}</div>` : h`<div class="muted">None yet.</div>`; body.querySelectorAll('[data-set]').forEach(b => b.onclick = async () => show(await api('/media/thumbnails/' + b.dataset.set))); };
      sets();
      body.querySelector('#go').onclick = async e => {
        const file = body.querySelector('#file').value.trim(); if (!file) return toast('Video path is required');
        busy(e.target, true); body.querySelector('#out').innerHTML = h`<div class="loading"><span class="spinner"></span> Extracting frames, composing, scoring…</div>`;
        try {
          const ai = body.querySelector('#ai').value.trim();
          const s = await api('/media/thumbnails', { method: 'POST', body: { file, title: body.querySelector('#title').value.trim(), headlines: body.querySelector('#heads').value.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 3), styles: [...body.querySelectorAll('.st:checked')].map(x => x.value), frames: Number(body.querySelector('#frames').value) || 3, ai: ai ? { prompt: ai } : null } });
          show(s); sets();
        } catch (x) { body.querySelector('#out').innerHTML = h`<div class="note bad">${x.message}</div>`; }
        busy(e.target, false);
      };
    } else {
      const ch = state.current;
      body.innerHTML = h`<div class="card tight row" style="margin-bottom:12px"><span class="mini">Based on ${ch ? h`<b>${ch.title}</b>'s` : 'the selected channel\'s'} best-performing titles · about 300 quota units</span><button id="go" class="primary" ${ch ? '' : 'disabled'}>Find similar channels</button></div><div id="out"></div>`;
      body.querySelector('#go').onclick = async e => {
        busy(e.target, true); const out = body.querySelector('#out'); out.innerHTML = h`<div class="loading"><span class="spinner"></span></div>`;
        try {
          const d = await api(`/channels/${ch.id}/similar-channels`);
          out.innerHTML = h`<div class="mini" style="margin-bottom:8px">Searched: ${d.basedOn.queries.map(q => `"${q}"`).join(', ')}</div><div class="card"><table><thead><tr><th>Channel</th><th class="num">Score</th><th class="num">Hits</th><th class="num">Subs</th><th class="num">Views / video</th><th class="num">Size fit</th><th></th></tr></thead><tbody>${d.results.map(c => h`<tr><td><div class="vt"><img class="avatar" src="${c.thumbnail || ''}"><div><div class="t">${c.title}${c.tracked ? ' <span class="badge">tracked</span>' : ''}</div><div class="m">${(c.sampleTitles || [])[0] || c.handle || ''}</div></div></div></td><td class="num"><b>${c.score}</b></td><td class="num">${c.hits}</td><td class="num">${fmt(c.subscriber_count)}</td><td class="num">${fmt(c.views_per_video)}</td><td class="num">${Math.round(c.sizeFit * 100)}%</td><td class="row">${c.tracked ? '' : h`<button class="sm" data-comp="${c.id}">+ competitor</button>`}<a class="btn sm" href="https://youtube.com/channel/${c.id}" target="_blank">↗</a></td></tr>`).join('')}</tbody></table></div>`;
          out.querySelectorAll('[data-comp]').forEach(b => b.onclick = async () => { busy(b, true); try { const c = await api(`/competitors/${ch.id}`, { method: 'POST', body: { input: b.dataset.comp } }); toast(`Tracking ${c.title}`, 'ok'); b.replaceWith(Object.assign(document.createElement('span'), { className: 'badge', textContent: 'tracked' })); } catch (x) { err(x); busy(b, false); } });
        } catch (x) { out.innerHTML = h`<div class="note bad">${x.message}</div>`; }
        busy(e.target, false);
      };
    }
  });
})();
