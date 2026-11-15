"""Chrome 151+ 填充验收：触发真实工具栏操作，保留发行版权限。"""
import base64
import json
import os
import tempfile
import time
import uuid
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
CHROME = os.environ.get('CHROME_BIN', '/root/python/.playwright-browsers/chromium-1234/chrome-linux64/chrome')
FORM = '''<!doctype html><html><body><form id="login"><label>账号<input name="username" autocomplete="username"></label><label>密码<input type="password" autocomplete="current-password"></label><button>登录</button></form><script>window.submits=0;window.inputs=0;document.addEventListener('submit',e=>{e.preventDefault();window.submits++});document.addEventListener('input',()=>window.inputs++);</script></body></html>'''


class Popup:
    def __init__(self, browser_cdp, page, target_id):
        self.cdp, self.page = browser_cdp, page
        self.responses = {}
        self.counter = 0
        self.session = browser_cdp.send('Target.attachToTarget', {'targetId': target_id, 'flatten': False})['sessionId']
        browser_cdp.on('Target.receivedMessageFromTarget', self.receive)

    def receive(self, event):
        if event.get('sessionId') == self.session:
            data = json.loads(event['message'])
            if 'id' in data:
                self.responses[data['id']] = data

    def send(self, method, params=None):
        self.counter += 1
        number = self.counter
        self.cdp.send('Target.sendMessageToTarget', {'sessionId': self.session, 'message': json.dumps({'id': number, 'method': method, 'params': params or {}})})
        deadline = time.monotonic() + 10
        while number not in self.responses and time.monotonic() < deadline:
            self.page.wait_for_timeout(30)
        result = self.responses.pop(number)
        assert 'error' not in result, result.get('error')
        return result['result']

    def evaluate(self, expression):
        result = self.send('Runtime.evaluate', {'expression': expression, 'awaitPromise': True, 'returnByValue': True, 'userGesture': True})
        assert 'exceptionDetails' not in result, 'Popup script failed'
        return result['result'].get('value')

    def wait(self, expression):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.evaluate(expression):
                return
            self.page.wait_for_timeout(50)
        raise AssertionError('Popup condition did not become true')


def run():
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='credmemo-fill-') as profile:
        ctx = p.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True,
            args=['--no-sandbox', '--enable-unsafe-extension-debugging', '--screen-info={1280x900}', f'--disable-extensions-except={ROOT / "dist"}', f'--load-extension={ROOT / "dist"}'], viewport={'width': 1280, 'height': 900})
        ctx.set_default_timeout(12000)
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
        base = worker.url.rsplit('/', 1)[0] + '/'
        client = ctx.new_page()
        client.goto(base + 'popup.html')
        client.locator('#auth-screen').wait_for(state='visible')
        master, first_password, second_password = [str(uuid.uuid4()) for _ in range(3)]
        master = master[:12]

        def raw(action, args=None):
            return client.evaluate('([action,args])=>chrome.runtime.sendMessage({type:"credmemo",action,args})', [action, args or {}])

        def request(action, args=None):
            result = raw(action, args)
            assert result['ok'], result.get('error')
            return result['data']

        request('initialize', {'password': master})
        entry = {'title': '示例邮箱', 'url': 'https://login.example.test/login', 'logins': [
            {'label': '主账号', 'username': 'demo@example.test', 'password': first_password},
            {'label': '备用账号', 'username': 'backup@example.test', 'password': second_password}],
            'totps': [{'label': 'RFC public vector', 'secret': 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'}]}
        saved = request('save', {'entry': entry})
        site = ctx.new_page()
        site.route('https://**/*', lambda route: route.fulfill(body=FORM, content_type='text/html'))
        site.goto('https://login.example.test/login')
        site.bring_to_front()
        assert request('target') is None
        assert site.locator('[name=username]').input_value() == ''
        browser_cdp = ctx.browser.new_browser_cdp_session()
        source_target = ctx.new_cdp_session(client).send('Target.getTargetInfo')['targetInfo']['targetId']

        def open_popup():
            site.bring_to_front()
            targets = browser_cdp.send('Target.getTargets', {'filter': [{}]})['targetInfos']
            tab = next(target for target in targets if target['type'] == 'tab' and target['url'] == site.url)
            browser_cdp.send('Extensions.triggerAction', {'id': base.split('/')[2], 'targetId': tab['targetId']})
            popup_target = None
            for _ in range(50):
                targets = browser_cdp.send('Target.getTargets')['targetInfos']
                popup_target = next((target for target in targets if target['url'] == base + 'popup.html' and target['targetId'] != source_target), None)
                if popup_target:
                    break
                client.wait_for_timeout(50)
            assert popup_target, 'Toolbar popup did not open'
            popup = Popup(browser_cdp, client, popup_target['targetId'])
            popup.wait('!!document.querySelector("[data-action=fill]")')
            return popup

        popup = open_popup()
        dimensions = popup.evaluate('({viewport:innerWidth,html:document.documentElement.scrollWidth,body:document.body.scrollWidth})')
        assert dimensions == {'viewport': 315, 'html': 315, 'body': 315}, dimensions
        assert popup.evaluate('[...document.querySelectorAll(".heading-actions button")].every(button=>!button.textContent.trim()&&!!button.getAttribute("aria-label"))')
        assert popup.evaluate('!document.querySelector("#page-title,[data-action=site-filter]")&&document.querySelector("#search-panel").hidden')
        assert popup.evaluate('!document.querySelector("[data-action=favorite],[data-action=filter]")')
        popup.wait('!document.querySelector("[data-action=copy-code]").disabled')
        # 无头浏览器打开原生弹窗后可能没有焦点窗口，按最近浏览器窗口定位测试页。
        target = client.evaluate('chrome.windows.getLastFocused().then(window=>chrome.tabs.query({active:true,windowId:window.id})).then(([tab])=>({id:tab.id,origin:new URL(tab.url).origin}))')
        target_id = target['id']
        assert target['origin'] == 'https://login.example.test'
        assert popup.evaluate('document.querySelectorAll(".entry-card").length') == 1
        assert popup.evaluate('document.querySelector(".entry-password>svg use").getAttribute("href").endsWith("#lock")')
        card_dimensions = popup.evaluate('Object.fromEntries([".entry-card",".entry-card-top",".entry-account",".entry-password",".totp-block",".entry-card-footer"].map(selector=>[selector,document.querySelector(selector).getBoundingClientRect().height]))')
        assert card_dimensions['.entry-card'] <= 190, card_dimensions
        print(f'PASS: native popup card height is {card_dimensions[".entry-card"]:.1f}px including multiple-account count and site fill', flush=True)
        assert popup.evaluate('!!document.querySelector(".card-actions [data-action=edit]")')
        assert popup.evaluate('!!document.querySelector(".entry-card-top .card-actions [data-action=delete]")')
        assert popup.evaluate('!document.querySelector("#site-context")')
        popup.evaluate('document.querySelector("[data-action=fill]").click()')
        popup.wait('document.querySelectorAll(".login-choice").length===2')
        popup.evaluate('document.querySelector(\'.login-choice[data-index="1"]\').click()')
        popup.wait('document.querySelector("#toast-root").textContent.includes("已填入")')
        assert site.locator('[name=username]').input_value() == 'backup@example.test'
        assert site.locator('[type=password]').input_value() == second_password
        assert site.evaluate('window.submits') == 0
        assert site.evaluate('window.inputs') == 2
        screenshot = ROOT / 'release' / 'screenshots' / 'popup-site.png'
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        popup.wait('!document.querySelector("#toast-root").textContent')
        screenshot.write_bytes(base64.b64decode(popup.send('Page.captureScreenshot', {'format': 'png'})['data']))
        print('PASS: real toolbar popup without site banner, account selection, native field events, no auto-submit', flush=True)

        tabs_before = client.evaluate('chrome.tabs.query({}).then(tabs=>tabs.map(tab=>tab.id).sort())')
        popup.evaluate('document.querySelector(".heading-actions [data-action=new]").click()')
        popup.wait('!!document.querySelector("#entry-form")')
        assert popup.evaluate('document.querySelector(".modal").getBoundingClientRect().width<=328')
        assert popup.evaluate('document.querySelector(".modal").getBoundingClientRect().height<=430')
        assert popup.evaluate('document.querySelector(".modal-body").scrollWidth<=document.querySelector(".modal-body").clientWidth')
        assert popup.evaluate('document.querySelector(".modal-body").scrollHeight<=document.querySelector(".modal-body").clientHeight')
        assert popup.evaluate('document.querySelectorAll(".primary-item .remove-item").length===0')
        assert popup.evaluate('document.querySelector(".login-item>.field-label").textContent==="账号"')
        assert popup.evaluate('!document.querySelector("[data-action=generate],.login-options")')
        assert popup.evaluate('(()=>{const body=document.querySelector(".modal-body").getBoundingClientRect();let bottom=body.top;return ["#entry-title","#entry-url",".login-item [data-field=username]",".login-item [data-field=password]",".token-item [data-field=secret]","#entry-notes"].every(selector=>{const rect=document.querySelector(selector).getBoundingClientRect(),valid=rect.top>=bottom&&rect.bottom<=body.bottom;bottom=rect.bottom;return valid})})()')
        assert popup.evaluate('document.querySelectorAll("#entry-form input[type=radio],.filter-tabs").length===0')
        assert popup.evaluate('(()=>{const field=document.querySelector(".token-item [data-field=secret]").getBoundingClientRect(),body=document.querySelector(".modal-body").getBoundingClientRect();return field.top>=body.top&&field.bottom<=body.bottom})()')
        popup.evaluate('document.querySelector("#entry-title").value="Popup 2FA fixture";document.querySelector(".token-item [data-field=secret]").value="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"')
        popup.evaluate('document.querySelector("#entry-notes").value="Synthetic note"')
        assert popup.evaluate('(()=>{const rect=document.querySelector("button[form=entry-form]").getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight})()')
        (screenshot.parent / 'popup-editor.png').write_bytes(base64.b64decode(popup.send('Page.captureScreenshot', {'format': 'png'})['data']))
        assert popup.evaluate('!document.querySelector("#entry-options,[data-action=add-login],[data-action=add-totp],#qr-image")')
        assert popup.evaluate('document.querySelector(".advanced-options").hidden')
        assert popup.evaluate('!document.querySelector(".login-options,[data-action=generate]")')
        assert popup.evaluate('document.querySelector(".token-item [data-field=secret]").placeholder==="输入 2FA 密钥"')
        assert popup.evaluate('!!document.querySelector(".token-item [data-action=scan-entry]")')
        popup.evaluate('document.querySelector("button[form=entry-form]").click()')
        popup.wait('!document.querySelector("#entry-form")&&document.querySelectorAll(".entry-card").length===2')
        created = next(item for item in request('list')['entries'] if item['title'] == 'Popup 2FA fixture')
        popup.evaluate(f'document.querySelector(\'[data-entry="{created["id"]}"] .card-actions [data-action=edit]\').click()')
        popup.wait('!!document.querySelector("#entry-form")')
        assert popup.evaluate('document.querySelector("#entry-notes").value') == 'Synthetic note'
        assert popup.evaluate('document.querySelector(".token-item [data-field=secret]").value') == 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
        popup.evaluate('document.querySelector("#entry-title").value="Updated popup fixture";document.querySelector("button[form=entry-form]").click()')
        popup.wait('!document.querySelector("#entry-form")')
        assert request('get', {'id': created['id']})['title'] == 'Updated popup fixture'
        popup.evaluate(f'document.querySelector(\'[data-entry="{created["id"]}"] .card-actions [data-action=delete]\').click()')
        popup.wait('!!document.querySelector("[data-action=confirm-delete]")')
        popup.wait('document.querySelector("#modal-root").getAnimations({subtree:true}).every(animation=>animation.playState!=="running")')
        assert len(request('list')['entries']) == 2
        (screenshot.parent / 'popup-delete.png').write_bytes(base64.b64decode(popup.send('Page.captureScreenshot', {'format': 'png'})['data']))
        popup.evaluate('document.querySelector(".modal-footer [data-action=close-modal]").click()')
        assert len(request('list')['entries']) == 2
        popup.evaluate(f'document.querySelector(\'[data-entry="{created["id"]}"] .card-actions [data-action=delete]\').click()')
        popup.wait('!!document.querySelector("[data-action=confirm-delete]")')
        popup.evaluate('document.querySelector("[data-action=confirm-delete]").click()')
        popup.wait('!document.querySelector("[data-action=confirm-delete]")&&document.querySelectorAll(".entry-card").length===1')
        assert raw('get', {'id': created['id']})['error'] == 'not_found'
        assert request('get', {'id': saved['id']})['logins'][0]['password'] == first_password
        request('save', {'entry': {'title': 'Backup fixture', 'totps': [{'secret': 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'}]}})
        popup.wait('document.querySelectorAll(".entry-card").length===2')
        print('PASS: compact card deletes only after confirmation; cancel and other credentials preserve saved data', flush=True)
        popup.evaluate('document.querySelector("#toolbar-more").click()')
        popup.evaluate('document.querySelector(".topbar [data-action=settings]").click()')
        popup.wait('!!document.querySelector("#theme-select")')
        (screenshot.parent / 'popup-settings.png').write_bytes(base64.b64decode(popup.send('Page.captureScreenshot', {'format': 'png'})['data']))
        dimensions = popup.evaluate('({height:document.querySelector(".modal").getBoundingClientRect().height,width:document.querySelector(".modal").getBoundingClientRect().width})')
        assert dimensions['height'] < 340, dimensions
        assert popup.evaluate('document.querySelector(".modal-body").scrollWidth<=document.querySelector(".modal-body").clientWidth')
        popup.evaluate('const select=document.querySelector("#theme-select");select.value="dark";select.dispatchEvent(new Event("change",{bubbles:true}))')
        assert popup.evaluate('document.documentElement.dataset.theme') == 'dark'
        popup.evaluate('document.querySelector("#modal-root [data-action=close-modal]").click()')
        print('PASS: native popup creates and edits 2FA; save footer stays visible; settings remain in popup', flush=True)

        downloads = Path(profile, 'downloads')
        downloads.mkdir()
        browser_cdp.send('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': str(downloads)})
        backup_password = str(uuid.uuid4())
        popup.evaluate('document.querySelector("#toolbar-more").click()')
        popup.evaluate('document.querySelector(".topbar [data-action=transfer]").click()')
        popup.wait('!!document.querySelector("#backup-form")')
        assert popup.evaluate('document.querySelector(".modal").getBoundingClientRect().height<440')
        assert popup.evaluate('document.querySelector(".modal-body").scrollWidth<=document.querySelector(".modal-body").clientWidth')
        (screenshot.parent / 'popup-backup.png').write_bytes(base64.b64decode(popup.send('Page.captureScreenshot', {'format': 'png'})['data']))
        popup.evaluate(f'document.querySelector("#backup-password").value={json.dumps(backup_password)};document.querySelector("#backup-confirm").value={json.dumps(backup_password)};document.querySelector("#backup-form button[type=submit]").click()')
        popup.wait('!document.querySelector("#backup-form")')
        for _ in range(100):
            backups = list(downloads.glob('*.credmemo'))
            if backups:
                break
            client.wait_for_timeout(50)
        assert backups
        assert json.loads(backups[0].read_text())['format'] == 'credmemo-backup'
        popup.evaluate('document.querySelector("#toolbar-more").click()')
        popup.evaluate('document.querySelector(".topbar [data-action=transfer]").click()')
        popup.wait('!!document.querySelector("[data-action=transfer-tab][data-tab=import]")')
        popup.evaluate('document.querySelector("[data-action=transfer-tab][data-tab=import]").click()')
        document = popup.send('DOM.getDocument')['root']['nodeId']
        node = popup.send('DOM.querySelector', {'nodeId': document, 'selector': '#import-file'})['nodeId']
        popup.send('DOM.setFileInputFiles', {'nodeId': node, 'files': [str(backups[0])]})
        popup.wait('!document.querySelector("#restore-password-field").hidden')
        popup.evaluate(f'document.querySelector("#restore-password").value={json.dumps(backup_password)};document.querySelector("#import-form button[type=submit]").click()')
        popup.wait('!document.querySelector("#import-form")&&document.querySelectorAll(".entry-card").length===4')
        tabs_after = client.evaluate('chrome.tabs.query({}).then(tabs=>tabs.map(tab=>tab.id).sort())')
        assert tabs_before == tabs_after
        assert raw('manage') == {'ok': False, 'error': 'invalid_input'}
        print('PASS: native popup downloads encrypted backup and restores it without opening tabs', flush=True)

        assert request('fill', {'id': saved['id'], 'index': 0, 'tabId': target_id})['filled'] == 2
        assert site.locator('[type=password]').input_value() == first_password
        assert site.evaluate('window.submits') == 0
        print('PASS: only the selected account reaches the page', flush=True)

        site.goto('https://login.example.test/multiple')
        site.set_content('<form id="one"><input name="username"><input type="password"></form><form id="two"><input name="username"><input type="password"></form>')
        result = raw('fill', {'id': saved['id'], 'index': 0, 'tabId': target_id})
        assert not result['ok'] and result['error'] == 'ambiguous_form'
        assert all(not value for value in site.locator('input').evaluate_all('(inputs)=>inputs.map(input=>input.value)'))
        site.locator('#two input[name=username]').focus()
        assert request('fill', {'id': saved['id'], 'index': 0, 'tabId': target_id})['filled'] == 2
        assert site.locator('#one input[type=password]').input_value() == ''
        assert site.locator('#two input[type=password]').input_value() == first_password
        print('PASS: ambiguous forms blocked; focused form receives credentials', flush=True)

        site.set_content('<form><input name="username" autocomplete="username"><input type="hidden" name="password"><button>下一步</button></form>')
        assert request('fill', {'id': saved['id'], 'index': 0, 'tabId': target_id})['usernameOnly']
        assert site.locator('[name=username]').input_value() == 'demo@example.test'
        assert site.locator('[type=hidden]').input_value() == ''
        site.set_content('<form><input name="username" disabled><input type="password" readonly></form>')
        assert raw('fill', {'id': saved['id'], 'index': 0, 'tabId': target_id})['error'] == 'no_fields'
        print('PASS: username-only flow; hidden, disabled and readonly fields stay empty', flush=True)

        for url in ['https://login.example.test.evil.test/login', 'https://login.example.test:8443/login']:
            site.goto(url)
            # 真实工具栏操作允许读取当前地址，再由凭证来源校验阻止跨站填充。
            targets = browser_cdp.send('Target.getTargets', {'filter': [{}]})['targetInfos']
            tab = next(target for target in targets if target['type'] == 'tab' and target['url'] == site.url)
            browser_cdp.send('Extensions.triggerAction', {'id': base.split('/')[2], 'targetId': tab['targetId']})
            assert raw('fill', {'id': saved['id'], 'index': 0, 'tabId': target_id})['error'] == 'site_mismatch'
            assert site.locator('[type=password]').input_value() == ''
        print('PASS: malicious lookalike hostname and changed port never receive credentials', flush=True)

        probe = ctx.new_page()
        probe.goto(base + 'static/favicon.svg')
        denied = probe.evaluate('chrome.runtime.sendMessage({type:"credmemo",action:"list"})')
        assert denied == {'ok': False, 'error': 'forbidden'}
        assert site.evaluate('typeof chrome.runtime?.sendMessage') == 'undefined'
        print('PASS: messages from non-UI contexts are rejected', flush=True)
        ctx.close()
    print('Fill acceptance complete.', flush=True)


if __name__ == '__main__':
    run()
