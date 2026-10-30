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
env2 = dict(os.environ, PORT=str(port), TUBEDESK_DATA_DIR=data, TUBEDESK_NO_SCHEDULER='1', YT_API_BASE=f'http://127.0.0.1:{mock_port}/youtube/v3', YT_ANALYTICS_BASE=f'http://127.0.0.1:{mock_port}/v2/reports', YT_SUGGEST_URL=f'http://127.0.0.1:{mock_port}/complete/search')
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

ROUTES = ['/', '/channels', '/library', '/analytics/overview', '/analytics/traffic', '/analytics/audience', '/analytics/subscribers', '/analytics/watch', '/analytics/content', '/analytics/slots', '/analytics/studio', '/analytics/revenue',
          '/keywords?q=medicaid', '/keywords?q=medicaid&mode=compete', '/outliers', '/outliers?mode=search&q=medicaid', '/trending', '/trending?tab=niche', '/trending?tab=patterns',
          '/competitors/compare', '/competitors/feed', '/competitors/alerts', '/competitors/cards', '/competitors/history', '/boards', '/boards?tab=blueprints', '/boards?tab=saved',
          '/packaging/title?title=7%20Medicaid%20Rules', '/packaging/description', '/packaging/chapters', '/packaging/thumbnail', '/packaging/translate', '/packaging/health', '/packaging/staged', '/packaging/safety',
          '/coach/chat', '/coach/ideas', '/coach/audit', '/coach/plan', '/coach/validate', '/coach/beginner', '/coach/lessons', '/coach/context',
          '/production/script', '/production/transcript', '/production/clips', '/production/repurpose', '/production/hook', '/comments', '/comments?filter=questions', '/calculators', '/settings']
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
    b.close()
srv.kill(); mock.kill()
if errors:
    print('UI ERRORS:'); [print(' -', e) for e in errors]; sys.exit(1)
print(f'UI smoke OK: {len(ROUTES)} routes rendered without console/page errors; screenshots in test/screenshots/')
