"""验证码类型、展开搜索及持久排序的真实扩展验收。"""
import json
import tempfile
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from fill_acceptance import CHROME, Popup

ROOT = Path(__file__).resolve().parents[2]
PUBLIC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
PUBLIC_HEX = '3132333435363738393031323334353637383930'


def run():
    screenshots = ROOT / 'release/screenshots'
    screenshots.mkdir(parents=True, exist_ok=True)
    master = str(uuid.uuid4())[:12]
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='credmemo-otp-list-') as profile:
        def launch():
            return p.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True,
                args=['--no-sandbox', '--enable-unsafe-extension-debugging', '--screen-info={1280x900}',
                    f'--disable-extensions-except={ROOT / "dist"}', f'--load-extension={ROOT / "dist"}'],
                viewport={'width': 315, 'height': 600}, locale='zh-CN')

        ctx = launch()
        ctx.set_default_timeout(12000)
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
        base = worker.url.rsplit('/', 1)[0] + '/'
        client = ctx.new_page()
        client.goto(base + 'popup.html')
        errors = []
        client.on('pageerror', lambda error: errors.append(str(error)))

        def request(action, args=None):
            result = client.evaluate('([action,args])=>chrome.runtime.sendMessage({type:"credmemo",action,args})', [action, args or {}])
            assert result['ok'], result.get('error')
            return result['data']

        client.locator('#auth-password').fill(master)
        client.locator('#confirm-password').fill(master)
        client.locator('#auth-form button[type=submit]').click()
        expect(client.locator('#app-screen')).to_be_visible()
        for kind in ['totp', 'hotp', 'steam', 'battle', 'hex', 'hhex']:
            client.locator('.heading-actions [data-action=new]').click()
            expect(client.locator('#entry-title')).to_be_focused()
            client.locator('#entry-title').fill(kind.upper() + ' fixture')
            if kind in ['totp', 'hotp']:
                client.locator('#entry-url').fill('https://login.example.test')
            expect(client.locator('.token-type')).to_be_hidden()
            expect(client.locator('.token-heading select')).to_have_count(0)
            settings = client.locator('.otp-dialog')
            client.locator('[data-action=token-options]').click()
            client.locator('.token-type').select_option(kind)
            assert client.locator('.token-type option').count() == 6
            if kind in ['hotp', 'hhex']:
                expect(client.locator('.counter-option')).to_be_visible()
                expect(client.locator('.period-option')).to_be_hidden()
            if kind == 'hex':
                settings.locator('[name=algorithm]').select_option('GOST3411_2012_512')
                settings.locator('[name=period]').fill('45')
                settings.locator('[name=digits]').fill('10')
            settings.locator('button[type=submit]').click()
            expect(settings).to_have_count(0)
            client.locator('.token-item [data-field=secret]').fill(PUBLIC_HEX if kind in ['hex', 'hhex'] else PUBLIC_SECRET)
            if kind == 'totp':
                assert client.locator('.modal-body').evaluate('node=>node.scrollHeight<=node.clientHeight')
                client.screenshot(path=str(screenshots / 'otp-editor-default.png'))
            client.locator('button[form=entry-form]').click()
            expect(client.locator('#entry-form')).to_have_count(0)
        entries = request('list')['entries']
        assert {entry['totps'][0].get('type', 'totp') for entry in entries} == {'totp','hotp','steam','battle','hex','hhex'}
        ids = {entry['totps'][0].get('type','totp'): entry['id'] for entry in entries}
        hotp = client.locator(f'[data-entry="{ids["hotp"]}"]')
        expect(hotp.locator('.totp-code')).to_have_text('755 224')
        client.wait_for_timeout(1100)
        expect(hotp.locator('.totp-code')).to_have_text('755 224')
        hotp.locator('[data-action=advance]').click()
        expect(hotp.locator('.totp-code')).to_have_text('287 082')
        assert request('get', {'id': ids['hotp']})['totps'][0]['counter'] == 1
        print('PASS: all six OTP types can be created; GOST and extended parameters save; HOTP advances explicitly', flush=True)

        for kind, entry_id in ids.items():
            saved = request('get', {'id': entry_id})
            client.locator(f'[data-entry="{entry_id}"] [data-action=edit]').click()
            expect(client.locator('.token-type')).to_be_hidden()
            client.locator('[data-action=token-options]').click()
            expect(client.locator('.token-type')).to_have_value(kind)
            client.locator('.token-type').select_option('totp' if kind != 'totp' else 'hotp')
            settings.locator('.modal-footer button[type=button]').click()
            expect(settings).to_have_count(0)
            client.locator('#entry-notes').fill('Preserve the selected verification code settings')
            client.locator('button[form=entry-form]').click()
            expect(client.locator('#entry-form')).to_have_count(0)
            assert request('get', {'id': entry_id})['totps'] == saved['totps']
        print('PASS: canceling the settings dialog preserves all six types, parameters and HOTP counters during editing', flush=True)

        for title, url, label in [('工作 Example', '', ''), ('Label match', '', 'Example:secondary'), ('Example wrong site', 'https://unrelated.test', '')]:
            request('save', {'entry': {'title': title, 'url': url, 'logins': [], 'totps': [{'secret': PUBLIC_SECRET, 'label': label}]}})
        site = ctx.new_page()
        site.route('https://**/*', lambda route: route.fulfill(body='<html><title>Example</title><input name="username"></html>', content_type='text/html'))
        site.goto('https://accounts.example.test/login')
        site_cdp = ctx.new_cdp_session(site)
        window = site_cdp.send('Browser.getWindowForTarget')
        site_cdp.send('Browser.setWindowBounds', {'windowId':window['windowId'],'bounds':{'width':1280,'height':900}})
        browser_cdp = ctx.browser.new_browser_cdp_session()
        source_target = ctx.new_cdp_session(client).send('Target.getTargetInfo')['targetInfo']['targetId']

        def popup():
            site.bring_to_front()
            targets = browser_cdp.send('Target.getTargets', {'filter': [{}]})['targetInfos']
            tab = next(target for target in targets if target['type']=='tab' and target['url']==site.url)
            browser_cdp.send('Extensions.triggerAction', {'id': base.split('/')[2], 'targetId': tab['targetId']})
            for _ in range(60):
                targets = browser_cdp.send('Target.getTargets')['targetInfos']
                current = next((target for target in targets if target['url']==base+'popup.html' and target['targetId']!=source_target), None)
                if current:
                    view = Popup(browser_cdp, client, current['targetId'])
                    view.wait('!!document.querySelector("#entries .entry-card")')
                    return view
                client.wait_for_timeout(50)
            raise AssertionError('Toolbar popup did not open')

        view = popup()
        visible = lambda: view.evaluate('[...document.querySelectorAll("#entries [data-entry]")].map(node=>node.dataset.entry)')
        assert len(visible()) == 9
        assert view.evaluate('!document.querySelector("#page-title,[data-action=site-filter]")')
        view.evaluate('document.querySelector("[data-action=search-toggle]").click()')
        view.evaluate('const input=document.querySelector("#search");input.value="fixture";input.dispatchEvent(new Event("input",{bubbles:true}))')
        assert len(visible()) == 6
        assert view.evaluate('!document.querySelector("[data-action=fill]")')
        names = view.evaluate('[...document.querySelectorAll(".entry-title h3")].map(node=>node.textContent)')
        assert set(names) == {kind.upper()+' fixture' for kind in ['totp','hotp','steam','battle','hex','hhex']}
        before = [entry['id'] for entry in request('list')['entries']]
        shown = visible()
        expected = before[:]
        first_slot, second_slot = before.index(shown[0]), before.index(shown[1])
        expected[first_slot], expected[second_slot] = expected[second_slot], expected[first_slot]
        view.evaluate('document.querySelectorAll(".drag-handle")[1].focus()')
        view.send('Input.dispatchKeyEvent', {'type':'keyDown','key':'ArrowUp','code':'ArrowUp','windowsVirtualKeyCode':38})
        view.send('Input.dispatchKeyEvent', {'type':'keyUp','key':'ArrowUp','code':'ArrowUp','windowsVirtualKeyCode':38})
        view.wait('document.querySelector("#toast-root").textContent.includes("顺序已保存")')
        assert [entry['id'] for entry in request('list')['entries']] == expected
        assert visible()[:2] == [shown[1], shown[0]]
        view.evaluate('document.querySelector("#toolbar-more").click()')
        view.evaluate('document.querySelector("[data-action=theme-options]").click()')
        view.evaluate('document.querySelector("[data-action=set-theme][data-theme=dark]").click()')
        dimensions = view.evaluate('({viewport:innerWidth,html:document.documentElement.scrollWidth,body:document.body.scrollWidth})')
        image = view.send('Page.captureScreenshot', {'format':'png'})['data']
        import base64
        (screenshots / 'otp-search-dark.png').write_bytes(base64.b64decode(image))
        assert dimensions == {'viewport':315,'html':315,'body':315}, dimensions
        view.evaluate('document.querySelector("[data-action=search-close]").click()')
        view.wait('document.querySelectorAll("#entries [data-entry]").length===9')
        view.evaluate('window.close()')
        view = popup()
        assert len(visible()) == 9
        assert view.evaluate('document.querySelector("#search-panel").hidden')
        view.evaluate('window.close()')
        print('PASS: native toolbar shows all websites; search expands on demand; keyboard sorting preserves hidden search slots', flush=True)

        client.reload()
        expect(client.locator('.entry-card')).to_have_count(9)
        before = [entry['id'] for entry in request('list')['entries']]
        source = client.locator(f'[data-entry="{before[0]}"] .drag-handle')
        target = client.locator(f'[data-entry="{before[1]}"]')
        source.drag_to(target)
        client.wait_for_function('()=>document.querySelector("#toast-root").textContent.includes("顺序已保存")')
        after = [entry['id'] for entry in request('list')['entries']]
        assert after[:2] == before[1::-1] and after[2:] == before[2:]
        client.screenshot(path=str(screenshots / 'otp-list-all.png'))
        assert not errors, errors
        ctx.close()

        ctx = launch()
        client = ctx.new_page()
        client.goto(base + 'popup.html')
        expect(client.locator('#auth-screen')).to_be_visible()
        client.locator('#auth-password').fill(master)
        client.locator('#auth-form button[type=submit]').click()
        expect(client.locator('.entry-card')).to_have_count(9)
        assert [entry['id'] for entry in request('list')['entries']] == after
        assert request('get', {'id': ids['hotp']})['totps'][0]['counter'] == 1
        print('PASS: real mouse drag changes stored order; restart retains order and HOTP counter', flush=True)
        ctx.close()


if __name__ == '__main__':
    run()
