const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => { if (n === null || n === undefined) return '—'; n = Number(n); const a = Math.abs(n); if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(Math.round(n)); };
chrome.runtime.sendMessage({ path: '/ext/summary' }, r => {
  const out = document.getElementById('out');
  document.getElementById('open').href = (r?.base || 'http://localhost:4949') + '/';
  if (!r || !r.ok) { out.innerHTML = `<div class="err">${esc(r?.json?.error || 'TubeDesk unreachable')}</div>`; return; }
  const { channels, quota } = r.json;
  if (!channels.length) { out.innerHTML = '<div class="mini">No owned channels yet. Open the desk and add one.</div>'; return; }
  out.innerHTML = channels.map(c => `<div class="ch"><img src="${esc(c.thumbnail || '')}"><div><div class="t">${esc(c.title)}${c.unreadAlerts ? `<span class="badge">${c.unreadAlerts} alerts</span>` : ''}</div><div class="m">${fmt(c.subs)} subs${c.subsDelta !== null ? ` <span class="${c.subsDelta >= 0 ? 'up' : 'down'}">${c.subsDelta >= 0 ? '+' : ''}${c.subsDelta} today</span>` : ''} · ${fmt(c.views)} views</div>${c.latest ? `<div class="m">Latest: ${esc(c.latest.title)} — ${fmt(c.latest.view_count)} views</div>` : ''}</div>${c.score !== null ? `<div class="score ${c.score >= 70 ? 'good' : c.score >= 45 ? 'mid' : 'low'}" title="Channel score">${c.score}</div>` : ''}</div>`).join('') +
    `<div class="mini">API quota today: ${quota.units.toLocaleString()} / ${quota.limit.toLocaleString()} units</div>`;
});
document.getElementById('opts').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
