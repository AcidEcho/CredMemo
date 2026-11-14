"""在临时浏览器中手动允许无痕访问，验证共享凭证库、填充和扫码。"""
import base64
import json
import re
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from fill_acceptance import CHROME, Popup
from qr_acceptance import PUBLIC_SECRET, fixtures

ROOT = Path(__file__).resolve().parents[2]


def run():
    image = fixtures()['valid']
    html = f'''<!doctype html><meta charset="utf-8"><title>Private fixture</title>
    <body style="font:16px system-ui;margin:40px"><h1>无痕窗口测试</h1>
    <form><label>账号<input autocomplete="username"></label>
    <label>密码<input type="password" autocomplete="current-password"></label></form>
    <img id="qr" src="{image}" width="360" height="360"></body>'''.encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(html)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_port}/private'
    try:
        with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='credmemo-incognito-') as profile:
            def launch():
                ctx = p.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True,
                    ignore_default_args=['--disable-extensions'], viewport={'width': 1280, 'height': 900},
                    args=['--no-sandbox', '--enable-unsafe-extension-debugging', '--screen-info={1280x900}'], locale='zh-CN')
                ctx.set_default_timeout(12000)
                return ctx

            ctx = launch()
            cdp = ctx.browser.new_browser_cdp_session()
            extension_id = cdp.send('Extensions.loadUnpacked', {'path': str(ROOT / 'dist')})['id']
            base = f'chrome-extension://{extension_id}/'
            client = ctx.new_page(); client.goto(base + 'popup.html')
            assert client.evaluate('chrome.extension.isAllowedIncognitoAccess()') is False
            assert client.evaluate('chrome.action.getUserSettings()') == {'isOnToolbar': False}
            assert client.evaluate('typeof chrome.action.setUserSettings') == 'undefined'

            manager = ctx.new_page(); manager.goto('chrome://extensions/?id=' + extension_id)
            developer = manager.locator('extensions-toolbar #devMode')
            if not developer.evaluate('node=>node.checked'):
                developer.click()
            manager.locator('#allow-incognito').click()
            manager.wait_for_function('id=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}).then(items=>items.some(item=>item.id===id&&item.state==="ENABLED"&&item.incognitoAccess.isEnabled))', arg=extension_id)
            ctx.close()

            ctx = launch()
            if not ctx.service_workers:
                ctx.wait_for_event('serviceworker')
            cdp = ctx.browser.new_browser_cdp_session()
            client = ctx.new_page(); client.goto(base + 'popup.html')
            expect(client.locator('#auth-screen')).to_be_visible()
            assert client.evaluate('chrome.extension.isAllowedIncognitoAccess()') is True
            master, password = str(uuid.uuid4())[:12], str(uuid.uuid4())
            client.locator('#auth-password').fill(master)
            client.locator('#confirm-password').fill(master)
            client.locator('#auth-form button[type=submit]').click()
            expect(client.locator('#app-screen')).to_be_visible()

            def request(action, args=None):
                result = client.evaluate('([action,args])=>chrome.runtime.sendMessage({type:"credmemo",action,args})', [action, args or {}])
                assert result['ok'], result.get('error')
                return result['data']

            request('save', {'entry': {'title': '共享凭证测试', 'url': url,
                'logins': [{'username': 'fixture@example.test', 'password': password}],
                'totps': [{'secret': PUBLIC_SECRET}]}})
            window = client.evaluate('url=>chrome.windows.create({incognito:true,url}).then(window=>({id:window.id,tab:window.tabs[0].id,incognito:window.incognito}))', url)
            assert window['incognito'] is True
            source = ctx.new_cdp_session(client).send('Target.getTargetInfo')['targetInfo']['targetId']

            def target(kind, address):
                for _ in range(150):
                    value = next((item for item in cdp.send('Target.getTargets', {'filter': [{}]})['targetInfos']
                        if item['type'] == kind and item['url'] == address), None)
                    if value:
                        return value
                    client.wait_for_timeout(40)
                raise AssertionError('Browser target did not open')

            site = Popup(cdp, client, target('page', url)['targetId'])
            site.wait('document.querySelector("#qr")?.complete===true')

            def popup(trigger=True):
                if trigger:
                    cdp.send('Extensions.triggerAction', {'id': extension_id, 'targetId': target('tab', url)['targetId']})
                for _ in range(150):
                    value = next((item for item in cdp.send('Target.getTargets')['targetInfos']
                        if item['url'] == base + 'popup.html' and item['targetId'] != source), None)
                    if value:
                        view = Popup(cdp, client, value['targetId'])
                        view.wait('document.querySelector("#app-screen")?.hidden===false')
                        return view
                    client.wait_for_timeout(40)
                raise AssertionError('Incognito popup did not open')

            view = popup()
            view.wait('document.querySelectorAll(".entry-card").length===1&&!!document.querySelector("[data-action=fill]")')
            assert view.evaluate(f'chrome.tabs.get({window["tab"]}).then(tab=>tab.incognito)') is True
            view.evaluate('document.querySelector("[data-action=fill]").click()')
            view.wait('document.querySelector("#toast-root").textContent.includes("已填入")')
            assert site.evaluate('document.querySelector("[autocomplete=username]").value') == 'fixture@example.test'
            assert site.evaluate('document.querySelector("[type=password]").value') == password
            print('PASS: initial incognito access requires manual permission; authorization survives restart; private popup shares the vault and fills the private page', flush=True)

            view.evaluate('document.querySelector(".heading-actions [data-action=new]").click()')
            view.wait('!!document.querySelector("#entry-form")')
            view.evaluate('document.querySelector("#entry-title").value="无痕扫码凭证";document.querySelector("#entry-notes").value="草稿回填测试";document.querySelector("[data-action=scan-entry]").click()')
            site.wait('document.querySelector("#credmemo-qr-selection")?.dataset.state==="selecting"')
            rect = site.evaluate('(()=>{const rect=document.querySelector("#qr").getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height}})()')
            x, y = rect['x'] + 2, rect['y'] + 2
            site.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y})
            site.send('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': x, 'y': y, 'button': 'left', 'buttons': 1, 'clickCount': 1})
            x, y = rect['x'] + rect['width'] - 2, rect['y'] + rect['height'] - 2
            site.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y, 'buttons': 1})
            site.send('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})
            view = popup(trigger=False)
            view.wait('!!document.querySelector("#entry-form")')
            assert view.evaluate('document.querySelector("#entry-title").value') == '无痕扫码凭证'
            assert view.evaluate('document.querySelector("#entry-notes").value') == '草稿回填测试'
            assert view.evaluate('document.querySelector(".token-item [data-field=secret]").value') == PUBLIC_SECRET
            assert len(request('list')['entries']) == 1
            view.evaluate('document.querySelector("button[form=entry-form]").click()')
            view.wait('!document.querySelector("#entry-form")&&document.querySelectorAll(".entry-card").length===2')
            created = next(item for item in request('list')['entries'] if item['title'] == '无痕扫码凭证')
            assert request('get', {'id': created['id']})['totps'][0]['algorithm'] == 'SHA256'
            ctx.grant_permissions(['clipboard-read'])
            view.wait('Array.from(document.querySelectorAll("[data-action=copy-code]")).every(button=>!button.disabled)')
            view.evaluate(f'document.querySelector(\'[data-entry="{created["id"]}"] [data-action=copy-code]\').click()')
            view.wait('document.querySelector("#toast-root").textContent.includes("已复制")')
            assert re.fullmatch(r'\d{8}', view.evaluate('navigator.clipboard.readText()'))
            view.evaluate(f'document.querySelector(\'[data-entry="{created["id"]}"] [data-action=show-qr]\').click()')
            view.wait('document.querySelector("#totp-qr")?.width>=200')
            shots = ROOT / 'release/screenshots'; shots.mkdir(parents=True, exist_ok=True)
            (shots / 'popup-incognito.png').write_bytes(base64.b64decode(view.send('Page.captureScreenshot', {'format': 'png'})['data']))
            request('lock')
            view.wait('document.querySelector("#auth-screen")?.hidden===false&&!document.querySelector("#totp-qr")')
            assert PUBLIC_SECRET not in json.dumps(client.evaluate('chrome.storage.local.get(null)'))
            print('PASS: private-page selection restores the editor; Save persists to the shared encrypted vault; clipboard, binding QR and cross-window locking work', flush=True)
            ctx.close()
    finally:
        server.shutdown(); server.server_close()


if __name__ == '__main__':
    run()
