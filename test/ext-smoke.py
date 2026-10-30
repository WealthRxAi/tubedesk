"""Extension smoke test: loads the unpacked extension into Chromium (persistent context), serves a fake
youtube.com watch page and search page via request interception, and checks the TubeDesk panels render
with data from the real server + mock YouTube API."""
import json, os, subprocess, sys, tempfile, time, urllib.request, sqlite3
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
subprocess.run(['pkill', '-f', 'node test/mock-youtube.js']); subprocess.run(['pkill', '-f', 'node src/server.js']); time.sleep(0.5)
data = tempfile.mkdtemp(prefix='td-ext-')
mock_port, port = 4777, 4949  # extension host permission is fixed to 4949
mock = subprocess.Popen(['node', 'test/mock-youtube.js'], cwd=ROOT, env=dict(os.environ, MOCK_PORT=str(mock_port)), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
env2 = dict(os.environ, PORT=str(port), TUBEDESK_DATA_DIR=data, TUBEDESK_NO_SCHEDULER='1', YT_API_BASE=f'http://127.0.0.1:{mock_port}/youtube/v3', YT_ANALYTICS_BASE=f'http://127.0.0.1:{mock_port}/v2/reports', YT_SUGGEST_URL=f'http://127.0.0.1:{mock_port}/complete/search')
srv = subprocess.Popen(['node', 'src/server.js'], cwd=ROOT, env=env2, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
import atexit; atexit.register(lambda: [p.kill() for p in (mock, srv)])
base = f'http://127.0.0.1:{port}'
def api(path, method='GET', body=None):
    req = urllib.request.Request(base + '/api' + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req) as r: return json.loads(r.read())
for _ in range(50):
    try: api('/status'); break
    except Exception: time.sleep(0.2)
api('/settings', 'PUT', {'yt_api_key': 'K', 'ai_provider': 'none'})
api('/channels', 'POST', {'input': '@TheParentPlan', 'kind': 'owned'})
vids = [v['id'] for v in api('/channels/UCowner00000000000000001/videos?limit=4')['videos']]; vid = vids[0]

def card(v): return f'<ytd-compact-video-renderer><ytd-thumbnail><a id="thumbnail" href="/watch?v={v}"><img></a></ytd-thumbnail><span>{v}</span></ytd-compact-video-renderer>'
WATCH = '<!doctype html><html><body><div id="columns"><div id="primary"><div id="below"><ytd-watch-metadata id="above-the-fold"><h1>Fake video</h1></ytd-watch-metadata><div id="comments">comments</div></div></div><div id="secondary">' + ''.join(card(v) for v in vids[1:]) + '</div></div></body></html>'
SEARCH = '<!doctype html><html><body><ytd-search><div id="contents"><div>result 1</div></div></ytd-search></body></html>'
CHANNEL = '<!doctype html><html><body><ytd-browse page-subtype="channels"><div id="header"><h1>Channel</h1></div><div id="contents">' + ''.join(f'<ytd-rich-item-renderer><ytd-thumbnail><a id="thumbnail" href="/watch?v={v}"><img></a></ytd-thumbnail></ytd-rich-item-renderer>' for v in vids) + '</div></ytd-browse></body></html>'
ext = os.path.join(ROOT, 'extension'); errors = []
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), headless=False, channel='chromium', args=[f'--disable-extensions-except={ext}', f'--load-extension={ext}'])
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(f'pageerror {e}'))
    pg.route('https://www.youtube.com/**', lambda route: route.fulfill(status=200, content_type='text/html', body=WATCH if '/watch' in route.request.url else CHANNEL if '/@' in route.request.url else SEARCH))
    pg.goto(f'https://www.youtube.com/watch?v={vid}'); pg.wait_for_selector('#td-panel .td-grid', timeout=15000)
    txt = pg.inner_text('#td-panel')
    assert 'views per day' in txt and 'vs channel median' in txt and 'Track channel' not in txt and 'your channel' in txt, txt
    assert 'est. video revenue' in txt and 'est. monthly revenue' in txt and 'SEO score' in txt and 'uploads / week' in txt and '$' in txt, txt
    assert 'unreachable' not in txt
    pg.wait_for_selector('ytd-compact-video-renderer .td-chip', timeout=15000)
    chips = pg.query_selector_all('.td-chip'); assert len(chips) == len(vids) - 1, len(chips)
    assert '/day' in chips[0].inner_text() and '$' in chips[0].inner_text(), chips[0].inner_text()
    pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'ext_watch.png'), full_page=True)
    pg.click('#td-save'); pg.wait_for_timeout(800); assert 'Saved to' in pg.inner_text('#td-save'), pg.inner_text('#td-save')
    pg.goto('https://www.youtube.com/results?search_query=medicaid'); pg.wait_for_selector('#td-search .td-grid', timeout=15000)
    st = pg.inner_text('#td-search'); assert 'demand index' in st and 'Competition evidence' in st, st
    pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'ext_search.png'), full_page=True)
    pg.goto('https://www.youtube.com/@CaregiverMoney'); pg.wait_for_selector('#td-channel .td-grid', timeout=15000)
    ct = pg.inner_text('#td-channel'); assert 'Caregiver Money' in ct and 'est. monthly revenue' in ct and 'est. yearly revenue' in ct and 'RECENT UPLOADS' in ct.upper() and 'Track as competitor' in ct, ct
    pg.wait_for_selector('ytd-rich-item-renderer .td-chip', timeout=15000)
    pg.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'ext_channel.png'), full_page=True)
    # popup
    sw = [w for w in ctx.service_workers] or [ctx.wait_for_event('serviceworker')]
    ext_id = sw[0].url.split('/')[2]
    pop = ctx.new_page(); pop.goto(f'chrome-extension://{ext_id}/popup.html'); pop.wait_for_selector('.ch', timeout=10000)
    pt = pop.inner_text('body'); assert 'The Parent Plan' in pt and 'API quota today' in pt, pt
    pop.screenshot(path=os.path.join(ROOT, 'test', 'screenshots', 'ext_popup.png'))
    ctx.close()
assert not errors, errors
print('Extension smoke OK: watch panel (revenue, SEO, channel card), thumbnail chips, channel panel, save-to-board, search panel, popup all rendered against the local server')
