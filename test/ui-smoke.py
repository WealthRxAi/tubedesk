"""UI smoke test: boots mock YouTube + server, seeds data, visits every page/tab in headless Chromium,
fails on any console error or uncaught page error, and saves screenshots to test/screenshots/."""
import json, os, subprocess, sys, tempfile, time, urllib.request, sqlite3
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data = tempfile.mkdtemp(prefix='td-ui-')
mock_port, port = 4777, 4778
subprocess.run(['pkill', '-f', 'node test/mock-youtube.js']); subprocess.run(['pkill', '-f', 'node src/server.js']); time.sleep(0.5)
import atexit; atexit.register(lambda: [p.kill() for p in (mock, srv)])
env = dict(os.environ, MOCK_PORT=str(mock_port))
mock = subprocess.Popen([sys.executable and 'node', 'test/mock-youtube.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
env2 = dict(os.environ, PORT=str(port), TUBEDESK_DATA_DIR=data, TUBEDESK_NO_SCHEDULER='1', YT_API_BASE=f'http://127.0.0.1:{mock_port}/youtube/v3', YT_ANALYTICS_BASE=f'http://127.0.0.1:{mock_port}/v2/reports', YT_SUGGEST_URL=f'http://127.0.0.1:{mock_port}/complete/search', YT_REPORTING_BASE=f'http://127.0.0.1:{mock_port}/reporting/v1', YT_UPLOAD_BASE=f'http://127.0.0.1:{mock_port}/upload', IG_GRAPH_BASE=f'http://127.0.0.1:{mock_port}/ig')
srv = subprocess.Popen(['node', 'src/server.js'], cwd=ROOT, env=env2, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
base = f'http://127.0.0.1:{port}'

def api(path, method='GET', body=None):
    req = urllib.request.Request(base + '/api' + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req) as r: return json.loads(r.read())

for _ in range(50):
    try: api('/status'); break
    except Exception: time.sleep(0.2)
OWNER = 'UCowner00000000000000001'
api('/settings', 'PUT', {'yt_api_key': 'K', 'google_client_id': 'c', 'google_client_secret': 's', 'ai_provider': 'none'})
api('/channels', 'POST', {'input': '@TheParentPlan', 'kind': 'owned'})
api(f'/competitors/{OWNER}', 'POST', {'input': '@CaregiverMoney'})
db = sqlite3.connect(os.path.join(data, 'tubedesk.sqlite'))
db.execute('UPDATE channels SET oauth_json = ? WHERE id = ?', (json.dumps({'access_token': 'tok', 'refresh_token': 'rt', 'expires_at': time.time() * 1000 + 3600e3}), OWNER)); db.commit(); db.close()
api(f'/analytics/{OWNER}/studio-import', 'POST', {'csv': 'Content,Video title,Impressions,Impressions click-through rate (%),Views\nowne0000000,Top,4000,3.0,1500\n'})
api(f'/boards/{OWNER}', 'POST', {'name': 'Inspo'})
api(f'/blueprints/{OWNER}', 'POST', {'title': 'Idea one', 'titles': ['A title']})
api(f'/competitors/{OWNER}/refresh', 'POST')
# Virality radar: calibrate (no AI), take two watch readings, score an idea with the fake Claude CLI, then switch AI back off.
api('/settings', 'PUT', {'radar_watch_days': '30', 'radar_watch_competitor_days': '30'})
api(f'/radar/calibrate/{OWNER}?wait=1', 'POST', {'ai': False})
api('/radar/watch/run', 'POST'); api('/radar/watch/run', 'POST')
api('/settings', 'PUT', {'ai_provider': 'claude-cli', 'claude_cli_path': os.path.join(ROOT, 'test', 'fake-claude.mjs')})
api('/radar/score', 'POST', {'channelId': OWNER, 'variants': [{'title': 'Nobody Warns You About Estate Recovery'}, {'title': 'Estate Recovery Explained'}], 'hook': 'Medicaid can take the house after your parent dies.'})
# Autopilot, CTR feed, daily ideas
api(f'/reach/{OWNER}/sync', 'POST')
api('/settings', 'PUT', {'autopilot_min_gain': '1', 'autopilot_max_days': '30', 'notify_quiet': ''})
api('/autopilot/run/owne0000001', 'POST', {'force': True})
api('/settings', 'PUT', {'autopilot_mode': 'suggest'}); api('/autopilot/run/owne0000002', 'POST', {'force': True}); api('/settings', 'PUT', {'autopilot_mode': 'auto', 'autopilot_min_gain': '99'})
api('/autopilot/run/owne0000003', 'POST', {'force': True})
api(f'/ideas/{OWNER}/run', 'POST', {})
# Shorts (fake whisper + real ffmpeg), Instagram reels on the watch, snapshots for the all-channels board
ffmpeg = next((f for f in ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'] if os.path.exists(f)), None)
src = os.path.join(data, 'episode.mp4'); model = os.path.join(data, 'ggml-test.bin'); open(model, 'w').write('x')
subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=45', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=45', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src], check=True)
api('/settings', 'PUT', {'whisper_path': os.path.join(ROOT, 'test', 'fake-whisper.mjs'), 'whisper_model': model, 'clips_min_seconds': '8', 'clips_max_seconds': '12', 'clips_count': '2', 'clips_publish': 'review',
                         'ig_access_token': 'IGTOKEN', 'ig_user_id': '17841400000000001', 'ig_username': 'salstack.ai', 'public_base_url': 'https://tubedesk.example.org'})
api('/autopilot/assets', 'POST', {'videoId': 'owne0000004', 'kind': 'source', 'path': src})
made = api('/shorts/make/owne0000004?wait=1', 'POST', {})
api(f"/shorts/clip/{made['clips'][0]['id']}/schedule", 'POST')
api('/radar/watch/run', 'POST')
db = sqlite3.connect(os.path.join(data, 'tubedesk.sqlite'))
for d, v, sb in [(14, 170000, 1100), (7, 176000, 1180)]:
    db.execute("INSERT OR REPLACE INTO snapshots (entity_type, entity_id, taken_at, day, views, subs) VALUES ('channel', ?, ?, date('now', ?), ?, ?)", (OWNER, time.strftime('%Y-%m-%dT%H:%M:%SZ'), f'-{d} days', v, sb))
db.commit(); db.close()
api('/settings', 'PUT', {'ai_provider': 'none'})

ROUTES = ['/', '/channels', '/library', '/analytics/overview', '/analytics/traffic', '/analytics/audience', '/analytics/subscribers', '/analytics/watch', '/analytics/content', '/analytics/slots', '/analytics/studio', '/analytics/revenue',
          '/keywords?q=medicaid', '/keywords?q=medicaid&mode=compete', '/outliers', '/outliers?mode=search&q=medicaid', '/trending', '/trending?tab=niche', '/trending?tab=patterns',
          '/competitors/compare', '/competitors/feed', '/competitors/alerts', '/competitors/cards', '/competitors/history', '/boards', '/boards?tab=blueprints', '/boards?tab=saved',
          '/packaging/title?title=7%20Medicaid%20Rules', '/packaging/description', '/packaging/chapters', '/packaging/thumbnail', '/packaging/translate', '/packaging/health', '/packaging/staged', '/packaging/safety',
          '/coach/chat', '/coach/ideas', '/coach/audit', '/coach/plan', '/coach/validate', '/coach/beginner', '/coach/lessons', '/coach/context',
          '/production/script', '/production/transcript', '/production/clips', '/production/repurpose', '/production/hook', '/comments', '/comments?filter=questions', '/calculators', '/settings',
          '/portfolio', '/radar/ideas', '/radar/score', '/radar/watch', '/radar/shorts', '/radar/autopilot', '/radar/calibration', '/radar/history', '/radar/method']
errors = []
os.makedirs(os.path.join(ROOT, 'test', 'screenshots'), exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1400, 'height': 900})
    pg.on('console', lambda m: errors.append(f'console[{m.type}] {m.text}') if m.type == 'error' and 'Failed to load resource' not in m.text else None)  # image CDN may be unreachable in CI
    pg.on('pageerror', lambda e: errors.append(f'pageerror {e}'))
    for r in ROUTES:
        pg.goto(base + '/#' + r); pg.wait_for_timeout(900)
        txt = pg.inner_text('#main')
        if 'Loading' in txt[:40] or len(txt.strip()) < 40: errors.append(f'{r}: page looks empty: {txt[:120]!r}')
        if 'Page not found' in txt: errors.append(f'{r}: not found')
        if '<div' in txt or '<tr' in txt or '<span' in txt: errors.append(f'{r}: escaped markup leak: ' + txt[txt.find('<'):txt.find('<')+80])
        if '[object Object]' in txt or 'undefined' in txt: errors.append(f'{r}: rendering leak: ' + txt[txt.find('undefined') - 60: txt.find('undefined') + 20] if 'undefined' in txt else f'{r}: object leak')
        pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', r.strip('/').replace('/', '_').replace('?', '_').replace('=', '-').replace('%20', '_') or 'dashboard') + '.png', full_page=True)
    # Interactions
    pg.goto(base + '/#/library'); pg.wait_for_timeout(800); print('LIB:', pg.inner_text('#main')[:400]); print('ERRS', errors[-5:]); pg.click('tr.clickable', timeout=5000); pg.wait_for_timeout(800)
    print('DRAWER:', pg.inner_text('#drawer')[:300]); print('ERRS', [e for e in errors if 'TUNNEL' not in e][-5:])
    pg.click('#dr-tabs a[data-t=check]'); pg.wait_for_timeout(300); assert 'Publishing checklist' in pg.inner_text('#drawer')
    pg.click('#dr-tabs a[data-t=ret]'); pg.wait_for_timeout(800); assert 'Audience retention' in pg.inner_text('#drawer')
    pg.click('#dr-tabs a[data-t=edit]'); pg.fill('#e-title', 'Changed title'); pg.click('#e-stage'); pg.wait_for_timeout(800)
    assert 'Changed title' in pg.inner_text('#main'), 'staged edit visible'
    pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'staged_after_edit.png'), full_page=True)
    pg.goto(base + '/#/packaging/title'); pg.wait_for_timeout(500); pg.fill('#t', 'How to Protect a Parent\'s House From Medicaid'); pg.click('#an'); pg.wait_for_timeout(500); assert 'Length 30' in pg.inner_text('#an-out')
    pg.goto(base + '/#/packaging/thumbnail'); pg.wait_for_timeout(500); pg.fill('#url', 'https://i.ytimg.com/vi/x/hqdefault.jpg'); pg.fill('#title', 'Test'); pg.click('#prev'); pg.wait_for_timeout(300); assert 'Mobile feed' in pg.inner_text('#preview')
    pg.goto(base + '/#/comments'); pg.wait_for_timeout(1200); pg.click('[data-reply]'); pg.wait_for_timeout(200); assert pg.is_visible('textarea[data-text]')
    pg.goto(base + '/#/calculators'); pg.wait_for_timeout(400); pg.click('#calc'); pg.wait_for_timeout(300); assert 'Ad revenue' in pg.inner_text('#out')
    pg.goto(base + '/#/keywords?q=medicaid'); pg.wait_for_timeout(800); pg.click('#compete'); pg.wait_for_timeout(1200); assert 'Opportunity score' in pg.inner_text('#out')
    pg.goto(base + '/#/outliers'); pg.wait_for_timeout(600); pg.click('#go'); pg.wait_for_timeout(1500); print('OUTL:', pg.inner_text('#out')[:200]); assert 'outlier' in pg.inner_text('#out').lower()
    # Virality radar interactions
    api('/settings', 'PUT', {'ai_provider': 'claude-cli', 'claude_cli_path': os.path.join(ROOT, 'test', 'fake-claude.mjs')})
    pg.goto(base + '/#/radar/score'); pg.wait_for_timeout(700)
    pg.fill('#titles', 'The Medicaid Lookback Rule That Costs Families $80K\nMedicaid lookback explained\nWhy Nobody Warns You About the 5-Year Lookback')
    pg.fill('#hook', 'If your mom gave you money in the last five years, Medicaid can deny her care. Here is the rule.')
    pg.click('#go'); pg.wait_for_selector('.radar-card', timeout=20000); pg.wait_for_timeout(300)
    out = pg.inner_text('#out'); assert 'Ranking' in out and 'Predicted' in out and 'Top pick' in out, out[:300]
    assert 'undefined' not in out and 'NaN' not in out and '[object' not in out, out[:400]
    pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'radar_score_result.png'), full_page=True)
    api('/settings', 'PUT', {'ai_provider': 'none'})
    pg.goto(base + '/#/radar/watch'); pg.wait_for_timeout(700); pg.click('tr[data-curve]'); pg.wait_for_timeout(900)
    assert 'Launch curve vs usual' in pg.inner_text('#drawer'); pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'radar_watch_curve.png'), full_page=True)
    pg.keyboard.press('Escape')
    pg.goto(base + '/#/library'); pg.wait_for_timeout(800); pg.click('tr.clickable'); pg.wait_for_timeout(600); pg.click('#dr-tabs a[data-t=radar]'); pg.wait_for_timeout(900)
    assert 'Radar score at publish' in pg.inner_text('#drawer'), pg.inner_text('#drawer')[:300]
    pg.keyboard.press('Escape')
    # Autopilot page: applied change with before/after, a suggestion with approve, a skip; approve then undo through the UI
    pg.goto(base + '/#/radar/autopilot'); pg.wait_for_timeout(1200)
    t = pg.inner_text('#main'); assert 'Changes and suggestions' in t and 'applied' in t and 'suggested' in t and 'skipped' in t, t[:500]
    assert 'Before' in t and 'After' in t and 'Diagnosis (packaging)' in t, t[:800]
    pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'radar_autopilot_full.png'), full_page=True)
    pg.click('[data-approve]'); pg.wait_for_timeout(1200); assert pg.locator('[data-approve]').count() == 0
    pg.click('[data-revert]'); pg.wait_for_timeout(1200); assert 'reverted' in pg.inner_text('#main')
    # Daily ideas + dashboard card + analytics CTR
    pg.goto(base + '/#/radar/ideas'); pg.wait_for_timeout(900)
    t = pg.inner_text('#main'); assert 'Today' in t and 'Evidence' in t and 'Refine in Score' in t, t[:500]
    pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'radar_ideas_full.png'), full_page=True)
    pg.click('[data-score]'); pg.wait_for_timeout(700); v = pg.input_value('#titles'); assert any(k in v for k in ('Lookback', 'Assisted Living', 'Power of Attorney')), v
    pg.goto(base + '/#/'); pg.wait_for_timeout(1200); assert "Today's top ideas" in pg.inner_text('#main')
    pg.goto(base + '/#/analytics/studio'); pg.wait_for_timeout(1200); t = pg.inner_text('#main'); assert 'Impressions & CTR — automatic' in t and 'live' in t, t[:400]
    pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'analytics_ctr_full.png'), full_page=True)
    # Shorts tab: engine status, best slots, clip previews with radar scores, one queued
    pg.goto(base + '/#/radar/shorts'); pg.wait_for_timeout(1500)
    t = pg.inner_text('#main'); assert 'Shorts from breakouts' in t and 'whisper.cpp' in t and 'Best Shorts slots' in t and 'queued' in t and 'ready' in t, t[:800]
    assert pg.locator('video.clip-vid').count() == 2
    pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'radar_shorts_full.png'), full_page=True)
    pg.click('[data-cancel]'); pg.wait_for_timeout(900); assert 'cancelled' in pg.inner_text('#main')
    # Live watch: Instagram section
    pg.goto(base + '/#/radar/watch'); pg.wait_for_timeout(1000); t = pg.inner_text('#main'); assert 'Instagram reels' in t and 'Reel 0' in t, t[:1200]
    pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'radar_watch_instagram.png'), full_page=True)
    # All channels board
    pg.goto(base + '/#/portfolio'); pg.wait_for_timeout(1500); t = pg.inner_text('#main')
    assert 'All channels' in t and 'The Parent Plan' in t and 'Views this week' in t and 'Instagram @salstack.ai' in t and '+33%' in t, t[:1200]
    pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'portfolio_full.png'), full_page=True)
    pg.goto(base + '/#/settings'); pg.wait_for_timeout(1200); assert 'whisper.cpp' in pg.inner_text('#main')
    pg.goto(base + '/#/radar/calibration'); pg.wait_for_timeout(600); pg.click('#cal'); pg.wait_for_timeout(4000)
    assert 'Rank accuracy' in pg.inner_text('#main')
    b.close()
srv.kill(); mock.kill()
if errors:
    print('UI ERRORS:'); [print(' -', e) for e in errors]; sys.exit(1)
print(f'UI smoke OK: {len(ROUTES)} routes rendered without console/page errors; screenshots in test/screenshots/')
