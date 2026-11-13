/* Instagram & TikTok: tracked Instagram accounts (Business Discovery), outliers, hashtag research, your TikTok videos */
(() => {
  const { view, api, h, raw, fmt, fmtFull, pct, ago, empty, err, toast, busy } = TD;

  view('/social', async (main, r) => {
    const tab = r.path.split('/')[2] || 'accounts';
    const st = await api('/social/status');
    main.innerHTML = h`<div class="page-head"><div><h1>Instagram & TikTok</h1><div class="sub">Official APIs only: any professional Instagram account's public posts (Business Discovery), hashtag top media, and your own TikTok videos. Instagram does not expose other accounts' view counts, so Instagram outliers use likes + comments vs the account's own median.</div></div>
      <div class="actions"><button id="syncall" class="sm">Re-sync all</button></div></div>
      ${st.instagram.configured ? '' : h`<div class="note bad" style="margin-bottom:12px">Instagram is not configured — add your account in Settings → Instagram publishing first (the same token powers research).</div>`}
      <div class="tabs">${[['accounts', `Accounts (${st.instagram.accounts})`], ['outliers', 'Outliers'], ['hashtags', 'Hashtags'], ['tiktok', `TikTok${st.tiktok.connected ? ' · @' + st.tiktok.username : ''}`]].map(([k, l]) => h`<a href="#/social/${k}" class="${tab === k ? 'active' : ''}">${l}</a>`).join('')}</div>
      <div id="body"><div class="loading"><span class="spinner"></span></div></div>`;
    main.querySelector('#syncall').onclick = async e => { busy(e.target, true); try { const r2 = await api('/social/ig/sync', { method: 'POST' }); if (st.tiktok.connected) await api('/social/tiktok/sync', { method: 'POST' }); toast(`Synced ${r2.synced} accounts${r2.failed.length ? `, ${r2.failed.length} failed` : ''}`, 'ok'); TD.route(); } catch (x) { err(x); } busy(e.target, false); };
    const body = main.querySelector('#body');
    try { body.innerHTML = await ({ accounts, outliers, hashtags, tiktok }[tab])(st, r); } catch (e) { body.innerHTML = h`<div class="note bad">${e.message}</div>`; }
    wire(body);
  });

  function post(m) {
    return h`<div class="row" style="gap:10px;align-items:center">${m.thumbnail ? h`<img src="${m.thumbnail}" style="width:44px;height:56px;object-fit:cover;border-radius:6px">` : ''}<div style="min-width:0"><a href="${m.permalink || '#'}" target="_blank" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px">${(m.caption || '(no caption)').slice(0, 90)}</a><span class="mini">${m.product_type === 'REELS' || m.productType === 'REELS' || m.media_type === 'VIDEO' || m.mediaType === 'VIDEO' ? 'Reel' : (m.media_type || m.mediaType || '').toLowerCase()} · ${ago(m.published_at || m.publishedAt)}</span></div></div>`;
  }

  async function accounts() {
    const list = await api('/social/ig/accounts');
    return h`<div class="card tight row" style="margin-bottom:12px"><input id="igadd" placeholder="Add an Instagram account: @username or profile URL (professional accounts only)" style="flex:1;min-width:260px"><input id="ignote" placeholder="note (optional)" style="width:160px"><button id="igaddbtn" class="primary">Track</button><input id="iglookup" placeholder="or one-off lookup: @username" style="width:200px"><button id="iglookupbtn" class="sm">Look up</button></div>
      <div id="lookup"></div>
      ${list.length ? h`<div class="card"><table class="tbl"><thead><tr><th>Account</th><th>Followers</th><th>+7d</th><th>Posts</th><th>Reels share</th><th>Posts/week</th><th>Median engagement</th><th>Eng. rate</th><th>Synced</th><th></th></tr></thead><tbody>
        ${raw(list.map(a => h`<tr><td><div class="row" style="gap:8px;align-items:center">${a.profile_picture ? h`<img src="${a.profile_picture}" style="width:28px;height:28px;border-radius:50%">` : ''}<div><a href="https://www.instagram.com/${a.username}/" target="_blank"><b>@${a.username}</b></a><div class="mini">${a.name || ''}${a.note ? ' · ' + a.note : ''}</div></div></div>${a.error ? h`<div class="mini bad">${a.error}</div>` : ''}</td>
          <td>${fmt(a.followers)}</td><td class="${(a.stats.followersGained7d || 0) >= 0 ? 'up' : 'down'}">${a.stats.followersGained7d == null ? '—' : fmt(a.stats.followersGained7d)}</td><td>${fmtFull(a.media_count)}</td><td>${a.stats.reelShare == null ? '—' : pct(a.stats.reelShare)}</td><td>${a.stats.postsPerWeek30d}</td><td>${fmt(a.stats.medianEngagement)}</td><td>${a.stats.engagementRate == null ? '—' : a.stats.engagementRate + '%'}</td><td class="mini">${a.synced_at ? ago(a.synced_at) : '—'}</td>
          <td><button class="sm" data-igsync="${a.username}">sync</button> <button class="sm" data-igdel="${a.username}">✕</button></td></tr>`).join(''))}</tbody></table></div>` : empty('Track a few accounts in your niche — their last 50 posts become the baseline for spotting breakouts.')}`;
  }

  async function outliers(st, r) {
    const days = r.query.days || 90, minX = r.query.minX || 1.5, reels = r.query.reels || '0';
    const rows = await api(`/social/ig/outliers?days=${days}&minX=${minX}&reels=${reels}&limit=100`);
    return h`<div class="card tight row" style="margin-bottom:12px"><label>Last <select id="o-days">${raw([30, 60, 90, 180, 365].map(d => `<option ${String(d) === String(days) ? 'selected' : ''}>${d}</option>`).join(''))}</select> days</label><label>≥ <select id="o-minx">${raw([1.5, 2, 3, 5, 10].map(x => `<option ${String(x) === String(minX) ? 'selected' : ''}>${x}</option>`).join(''))}</select>× the account's median</label><label><input type="checkbox" id="o-reels" ${reels === '1' ? 'checked' : ''}> Reels only</label></div>
      ${rows.length ? h`<div class="card"><table class="tbl"><thead><tr><th>Post</th><th>Account</th><th>×</th><th>Likes</th><th>Comments</th><th>Per 100 followers</th></tr></thead><tbody>${raw(rows.map(m => h`<tr><td>${raw(post(m))}</td><td><a href="https://www.instagram.com/${m.username}/" target="_blank">@${m.username}</a><div class="mini">${fmt(m.followers)} followers</div></td><td><b class="${m.x >= 3 ? 'up' : ''}">${m.x}×</b><div class="mini">median ${fmt(m.median)}</div></td><td>${fmt(m.likes)}</td><td>${fmt(m.comments)}</td><td>${m.perFollower == null ? '—' : m.perFollower}</td></tr>`).join(''))}</tbody></table></div>` : empty('No outliers yet — track accounts first, or lower the threshold.')}`;
  }

  async function hashtags(st, r) {
    const q = r.query.q || '', kind = r.query.kind || 'top';
    let out = '';
    if (q) {
      const d = await api(`/social/ig/hashtag?q=${encodeURIComponent(q)}&kind=${kind}`);
      out = h`<div class="stats" style="margin-bottom:12px">${raw(TD.stat('Posts', d.count))}${raw(TD.stat('Median engagement', fmt(d.medianEngagement)))}${raw(TD.stat('Reel share', d.reelShare == null ? '—' : pct(d.reelShare)))}${raw(TD.stat('Fetched', d.cached ? 'cached' : 'just now'))}</div>
        <div class="card"><table class="tbl"><thead><tr><th>Post</th><th>Likes</th><th>Comments</th><th>Engagement</th></tr></thead><tbody>${raw(d.media.map(m => h`<tr><td>${raw(post(m))}</td><td>${fmt(m.likes)}</td><td>${fmt(m.comments)}</td><td><b>${fmt(m.engagement)}</b></td></tr>`).join(''))}</tbody></table></div>`;
    }
    return h`<div class="card tight row" style="margin-bottom:12px"><input id="tag" value="${q}" placeholder="#hashtag" style="flex:1;min-width:200px"><select id="tagkind"><option value="top" ${kind === 'top' ? 'selected' : ''}>Top media</option><option value="recent" ${kind === 'recent' ? 'selected' : ''}>Recent media</option></select><button id="tagbtn" class="primary">Research</button><span class="mini">Instagram allows 30 unique hashtags per 7 days; results are cached for a day.</span></div>${raw(out)}`;
  }

  async function tiktok(st) {
    if (!st.tiktok.connected) return h`<div class="card"><h2>TikTok</h2><p>Not connected. Set up the TikTok app and connect in <a href="#/settings">Settings → TikTok</a>. Once connected: your videos with views, likes, comments, shares and × vs your median, plus publishing from any agent (<code>POST /api/publish/tiktok</code>).</p><p class="mini">TikTok has no official API for other creators' videos (its Research API is academics-only), so TubeDesk does not offer TikTok competitor research.</p></div>`;
    const vids = await api('/social/tiktok/videos?limit=100');
    return h`<div class="row" style="margin-bottom:12px;align-items:center"><span class="mini">@${st.tiktok.username} · ${vids.length} videos synced${st.tiktok.audited ? '' : ' · app not audited: new posts land as "Only me"'}</span><button id="ttsync" class="sm">Sync videos</button></div>
      ${vids.length ? h`<div class="card"><table class="tbl"><thead><tr><th>Video</th><th>Views</th><th>×</th><th>Views/day</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Eng.</th></tr></thead><tbody>${raw(vids.map(v => h`<tr><td><div class="row" style="gap:10px;align-items:center">${v.cover ? h`<img src="${v.cover}" style="width:44px;height:56px;object-fit:cover;border-radius:6px">` : ''}<div><a href="${v.share_url || '#'}" target="_blank">${(v.title || v.description || '(untitled)').slice(0, 80)}</a><div class="mini">${ago(v.published_at)} · ${v.duration || '?'}s</div></div></div></td><td>${fmt(v.views)}</td><td><b class="${v.x >= 2 ? 'up' : ''}">${v.x}×</b></td><td>${fmt(v.viewsPerDay)}</td><td>${fmt(v.likes)}</td><td>${fmt(v.comments)}</td><td>${fmt(v.shares)}</td><td>${v.engagement == null ? '—' : v.engagement + '%'}</td></tr>`).join(''))}</tbody></table></div>` : empty('No videos synced yet — click Sync videos.')}`;
  }

  function wire(body) {
    const q = s => body.querySelector(s);
    if (q('#igaddbtn')) q('#igaddbtn').onclick = async e => { const u = q('#igadd').value.trim(); if (!u) return; busy(e.target, true); try { const a = await api('/social/ig/accounts', { method: 'POST', body: { username: u, note: q('#ignote').value } }); toast(`Tracking @${a.username} (${a.synced} posts)`, 'ok'); TD.route(); } catch (x) { err(x); } busy(e.target, false); };
    if (q('#iglookupbtn')) q('#iglookupbtn').onclick = async e => { const u = q('#iglookup').value.trim(); if (!u) return; busy(e.target, true); try { const d = await api(`/social/ig/lookup?username=${encodeURIComponent(u)}`); q('#lookup').innerHTML = h`<div class="card" style="margin-bottom:12px"><div class="row" style="gap:12px;align-items:center">${d.profilePicture ? h`<img src="${d.profilePicture}" style="width:48px;height:48px;border-radius:50%">` : ''}<div><b>@${d.username}</b> ${d.name || ''} · ${fmt(d.followers)} followers · ${fmtFull(d.mediaCount)} posts${d.website ? h` · <a href="${d.website}" target="_blank">site</a>` : ''}<div class="mini">${(d.biography || '').slice(0, 200)}</div></div></div><table class="tbl" style="margin-top:10px"><tbody>${raw(d.media.slice(0, 12).map(m => h`<tr><td>${raw(post(m))}</td><td>${fmt(m.likes)} likes</td><td>${fmt(m.comments)} comments</td></tr>`).join(''))}</tbody></table></div>`; } catch (x) { err(x); } busy(e.target, false); };
    body.querySelectorAll('[data-igsync]').forEach(b => b.onclick = async () => { busy(b, true); try { await api(`/social/ig/accounts/${b.dataset.igsync}/sync`, { method: 'POST' }); TD.route(); } catch (x) { err(x); busy(b, false); } });
    body.querySelectorAll('[data-igdel]').forEach(b => b.onclick = async () => { if (confirm(`Stop tracking @${b.dataset.igdel}?`)) { await api(`/social/ig/accounts/${b.dataset.igdel}`, { method: 'DELETE' }); TD.route(); } });
    const go = () => TD.go('/social/outliers', { days: q('#o-days').value, minX: q('#o-minx').value, reels: q('#o-reels').checked ? '1' : '0' });
    ['#o-days', '#o-minx', '#o-reels'].forEach(s => { if (q(s)) q(s).onchange = go; });
    if (q('#tagbtn')) q('#tagbtn').onclick = () => TD.go('/social/hashtags', { q: q('#tag').value.trim().replace(/^#/, ''), kind: q('#tagkind').value });
    if (q('#ttsync')) q('#ttsync').onclick = async e => { busy(e.target, true); try { const r = await api('/social/tiktok/sync', { method: 'POST' }); toast(`Synced ${r.synced} videos`, 'ok'); TD.route(); } catch (x) { err(x); } busy(e.target, false); };
  }
})();
