"""真实扩展验收；使用临时浏览器配置和随机测试数据。"""
import json
import os
import re
import tempfile
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
CHROME = os.environ.get('CHROME_BIN', '/root/python/.playwright-browsers/chromium-1234/chrome-linux64/chrome')
ARTIFACTS = ROOT / 'release' / 'screenshots'
PUBLIC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    errors, external = [], []
    master, next_master, backup_password, credential_password = [str(uuid.uuid4()) for _ in range(4)]
    master, next_master = master[:6], next_master[:12]
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='credmemo-acceptance-') as profile:
        def launch():
            ctx = p.chromium.launch_persistent_context(
                profile, executable_path=CHROME, headless=True, accept_downloads=True,
                args=['--no-sandbox', f'--disable-extensions-except={ROOT / "dist"}', f'--load-extension={ROOT / "dist"}'],
                viewport={'width': 390, 'height': 600}, locale='zh-CN')
            ctx.set_default_timeout(12000)
            ctx.on('page', lambda tab: tab.on('pageerror', lambda error: errors.append(str(error))))
            ctx.on('request', lambda request: external.append(request.url) if request.url.startswith(('https://', 'http://')) else None)
            worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
            return ctx, worker.url.rsplit('/', 1)[0] + '/'

        ctx, base = launch()
        page = ctx.new_page()
        page.goto(base + 'popup.html')
        expect(page.locator('#auth-title')).to_have_text('创建本地凭证库')
        expect(page.locator('#auth-password')).to_have_attribute('minlength', '6')
        expect(page.locator('#auth-password')).to_have_attribute('maxlength', '12')
        expect(page.locator('#auth-password')).to_have_attribute('placeholder', '设置 6～12 位主密码')
        page.screenshot(path=str(ARTIFACTS / 'setup-master-zh.png'))
        page.locator('.auth-preferences [data-action=language]').click()
        expect(page.locator('#auth-password')).to_have_attribute('placeholder', 'Choose 6–12 characters')
        page.screenshot(path=str(ARTIFACTS / 'setup-master-en.png'))
        page.locator('.auth-preferences [data-action=language]').click()
        page.locator('#auth-password').fill(master[:5])
        page.locator('#confirm-password').fill(master[:5])
        page.locator('#auth-form button[type=submit]').click()
        assert page.locator('#auth-password').evaluate('node=>node.validity.tooShort')
        expect(page.locator('#app-screen')).to_be_hidden()
        page.locator('#auth-password').fill(master)
        page.locator('#confirm-password').fill(master)
        page.locator('#auth-form button[type=submit]').click()
        expect(page.locator('#app-screen')).to_be_visible()
        expect(page.locator('#empty-state')).to_be_visible()
        print('PASS: first-run setup', flush=True)

        expect(page.locator('html')).to_have_attribute('data-theme', 'light')
        page.locator('.topbar [data-action=theme]').click()
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        page.locator('.topbar [data-action=theme]').click()
        expect(page.locator('html')).to_have_attribute('data-theme', 'light')
        print('PASS: one-click light/dark toggle from system theme', flush=True)

        def request(action, args=None):
            result = page.evaluate('([action,args])=>chrome.runtime.sendMessage({type:"credmemo",action,args})', [action, args or {}])
            assert result['ok'], result.get('error')
            return result['data']

        def close_modal():
            page.locator('#modal-root [data-action=close-modal]').first.click()

        def transfer(tab):
            page.locator('.topbar [data-action=transfer]').click()
            if tab != 'backup':
                page.locator(f'[data-action=transfer-tab][data-tab={tab}]').click()

        page.locator('.heading-actions [data-action=new]').click()
        page.wait_for_timeout(50)
        expect(page.locator('#entry-title')).to_be_focused()
        expect(page.locator('#entry-form input:visible:not([type=radio]):not([type=file])')).to_have_count(4)
        expect(page.locator('#entry-form input[type=radio], .filter-tabs')).to_have_count(0)
        expect(page.locator('#entry-group')).to_have_count(0)
        page.locator('#entry-title').fill('示例邮箱')
        expect(page.locator('#entry-url')).to_be_hidden()
        page.locator('#entry-options summary').click()
        page.locator('#entry-url').fill('https://login.example.test/login')
        first = page.locator('.login-item').first
        expect(page.locator('.login-options, [data-action=generate]')).to_have_count(0)
        expect(first.locator('.field-label').first).to_have_text('账号')
        first.locator('[data-field=username]').fill('demo@example.test')
        first.locator('[data-field=password]').fill(credential_password)
        page.locator('[data-action=add-login]').click()
        second = page.locator('.login-item').nth(1)
        second.locator('[data-field=username]').fill('backup@example.test')
        second.locator('[data-field=password]').fill(str(uuid.uuid4()))
        for index in range(2):
            if index:
                page.locator('[data-action=add-totp]').click()
            token = page.locator('.token-item').last
            expect(token.locator('.advanced-options')).to_be_hidden()
            token.locator('[data-field=secret]').fill(PUBLIC_SECRET)
        page.locator('#entry-notes').fill('仅供界面验收的虚构资料。')
        page.locator('button[form=entry-form][type=submit]').click()
        expect(page.locator('.entry-card')).to_have_count(1)
        expect(page.locator('.totp-code')).to_have_text(re.compile(r'\d{3} \d{3}'))
        first_id = request('list')['entries'][0]['id']
        legacy = request('get', {'id': first_id})
        for login, label in zip(legacy['logins'], ['主账号', '备用账号']):
            login['label'] = label
        for token, label in zip(legacy['totps'], ['邮箱验证器', '备用验证器']):
            token['label'] = label
        request('save', {'id': first_id, 'version': legacy['version'], 'entry': legacy})
        print('PASS: UI saves multiple accounts and 2FA', flush=True)

        for title, username in [('开发平台', 'developer@example.test'), ('演示网站', 'hello@example.test')]:
            page.locator('.heading-actions [data-action=new]').click()
            page.locator('#entry-title').fill(title)
            page.locator('#entry-options summary').click()
            page.locator('#entry-url').fill('https://example.test')
            page.locator('.login-item [data-field=username]').fill(username)
            page.locator('.login-item [data-field=password]').fill(str(uuid.uuid4()))
            page.locator('button[form=entry-form][type=submit]').click()
            expect(page.locator('#modal-root')).to_be_empty()
        expect(page.locator('.entry-card')).to_have_count(3)
        page.locator(f'.entry-card[data-entry="{first_id}"] [data-action=detail]').first.click()
        expect(page.locator('#drawer-root .detail-group')).to_have_count(4)
        expect(page.locator('#detail-password-0')).to_have_value(credential_password)
        page.locator('#drawer-root [data-action=edit]').click()
        page.locator('#entry-options summary').click()
        page.locator('#entry-notes').fill('已编辑的虚构资料。')
        page.locator('button[form=entry-form][type=submit]').click()
        expect(page.locator('#modal-root')).to_be_empty()
        assert request('get', {'id': first_id})['notes'] == '已编辑的虚构资料。'
        preserved = request('get', {'id': first_id})
        assert [item['label'] for item in preserved['logins']] == ['主账号', '备用账号']
        assert [item['label'] for item in preserved['totps']] == ['邮箱验证器', '备用验证器']
        card = page.locator(f'.entry-card[data-entry="{first_id}"]')
        card.locator('[data-action=favorite]').click()
        expect(card.locator('[data-action=favorite]')).to_have_class(re.compile('is-favorite'))
        page.locator('[data-action=filter][data-filter=favorite]').click()
        expect(page.locator('.entry-card')).to_have_count(1)
        page.locator('[data-action=filter][data-filter=favorite]').click()
        page.locator('#search').fill('developer@')
        expect(page.locator('.entry-card')).to_have_count(1)
        page.locator('#search').fill('missing-fixture')
        expect(page.locator('.entry-card')).to_have_count(0)
        expect(page.locator('#empty-state')).to_be_visible()
        page.locator('[data-action=clear]').click()
        expect(page.locator('.entry-card')).to_have_count(3)
        expect(page.locator('#group-filter, #sort, #site-context, #entry-group')).to_have_count(0)
        updated = {entry['id']: entry['updated_at'] for entry in request('list')['entries']}
        visible = page.locator('.entry-card').evaluate_all('cards=>cards.map(card=>card.dataset.entry)')
        timestamps = [updated[entry_id] for entry_id in visible]
        assert timestamps == sorted(timestamps, reverse=True)
        print('PASS: edit, favorites, search, empty-result reset and latest-update ordering without dropdowns', flush=True)

        ctx.grant_permissions(['clipboard-read'])
        card.locator('[data-action=copy-username]').click()
        assert page.evaluate('navigator.clipboard.readText()') == 'demo@example.test'
        card.locator('[data-action=copy-password]').click()
        assert page.evaluate('navigator.clipboard.readText()') == credential_password
        card.locator('[data-action=copy-code]').click()
        assert re.fullmatch(r'\d{6}', page.evaluate('navigator.clipboard.readText()'))
        print('PASS: actual clipboard contains selected values', flush=True)

        page.locator('.main-content').evaluate('node=>node.scrollTop=0')
        assert page.locator('.main-content').evaluate('node=>node.scrollWidth===node.clientWidth')
        page.screenshot(path=str(ARTIFACTS / 'popup-light.png'))
        page.locator('#header-avatar').click()
        page.locator('#theme-select').select_option('dark')
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        page.locator('#language-select').select_option('en')
        expect(page.locator('#modal-title')).to_have_text('Preferences')
        close_modal()
        expect(page.locator('#page-title')).to_have_text('All credentials')
        assert page.locator('.main-content').evaluate('node=>node.scrollWidth===node.clientWidth')
        page.screenshot(path=str(ARTIFACTS / 'popup-dark.png'))
        page.locator('#header-avatar').click()
        page.locator('#language-select').select_option('zh')
        page.locator('#theme-select').select_option('light')
        close_modal()
        print('PASS: rendered Chinese/English and light/dark themes', flush=True)

        initial_code = card.locator('.totp-code').inner_text()
        page.wait_for_function('(old)=>document.querySelector("[data-entry=\\"' + first_id + '\\"] .totp-code").textContent!==old', arg=initial_code, timeout=34000)
        expect(card.locator('.totp-code')).to_have_text(re.compile(r'\d{3} \d{3}'))
        assert card.locator('.totp-code').inner_text() != initial_code
        print('PASS: visible TOTP refreshes across real time boundary', flush=True)

        awaitable_popup = ctx.new_page()
        awaitable_popup.set_viewport_size({'width': 390, 'height': 600})
        awaitable_popup.goto(base + 'popup.html')
        expect(awaitable_popup.locator('.entry-card')).to_have_count(3)
        assert awaitable_popup.evaluate('document.documentElement.scrollWidth') == 390
        awaitable_popup.screenshot(path=str(ARTIFACTS / 'popup.png'), full_page=True)
        awaitable_popup.close()
        page.bring_to_front()

        transfer('backup')
        page.locator('#backup-password').fill(backup_password)
        page.locator('#backup-confirm').fill(backup_password)
        with page.expect_download() as download:
            page.locator('#backup-form button[type=submit]').click()
        backup = json.loads(Path(download.value.path()).read_text())
        assert backup['format'] == 'credmemo-backup' and backup['version'] == 2
        assert credential_password not in json.dumps(backup)
        expect(page.locator('#modal-root')).to_be_empty()
        transfer('export')
        page.locator('#export-password').fill(str(uuid.uuid4()))
        page.locator('#export-form button[value=download]').click()
        expect(page.locator('#transfer-error')).to_be_visible()
        page.locator('#export-password').fill(master)
        with page.expect_download() as download:
            page.locator('#export-form button[value=download]').click()
        exported = json.loads(Path(download.value.path()).read_text())
        assert len(exported['entries']) == 3
        assert any(entry['logins'][0]['password'] == credential_password for entry in exported['entries'])
        expect(page.locator('#modal-root')).to_be_empty()
        transfer('export')
        page.locator('#export-password').fill(master)
        page.locator('#export-form button[value=copy]').click()
        expect(page.locator('#modal-root')).to_be_empty()
        page.wait_for_function('async()=>{try{return JSON.parse(await navigator.clipboard.readText()).format==="credmemo-export"}catch{return false}}')
        print('PASS: encrypted backup and password-confirmed export/download/copy', flush=True)

        transfer('import')
        page.locator('#import-file').set_input_files({'name': 'invalid.json', 'mimeType': 'application/json', 'buffer': b'{invalid'})
        expect(page.locator('#transfer-error')).to_be_visible()
        page.locator('#import-file').set_input_files({'name': 'fixture.credmemo', 'mimeType': 'application/json', 'buffer': json.dumps(backup).encode()})
        page.locator('#restore-password').fill(str(uuid.uuid4()))
        page.locator('#import-form button[type=submit]').click()
        expect(page.locator('#transfer-error')).to_be_visible()
        assert len(request('list')['entries']) == 3
        page.locator('#restore-password').fill(backup_password)
        page.locator('#import-form button[type=submit]').click()
        expect(page.locator('.entry-card')).to_have_count(6)
        transfer('import')
        page.locator('#import-file').set_input_files({'name': 'fixture.json', 'mimeType': 'application/json', 'buffer': json.dumps({**exported, 'entries': exported['entries'][:1]}).encode()})
        page.locator('#import-form button[type=submit]').click()
        expect(page.locator('.entry-card')).to_have_count(7)
        print('PASS: invalid file/password preserve data; backup restore and JSON import append', flush=True)

        page.locator('.entry-card').first.locator('[data-action=detail]').first.click()
        page.locator('#drawer-root [data-action=delete]').click()
        page.locator('[data-action=confirm-delete]').click()
        expect(page.locator('.entry-card')).to_have_count(6)
        second_window = ctx.new_page()
        second_window.goto(base + 'popup.html')
        expect(second_window.locator('#app-screen')).to_be_visible()
        page.bring_to_front()
        page.locator('#header-avatar').click()
        page.locator('[data-action=change-password]').click()
        expect(page.locator('#new-password')).to_have_attribute('minlength', '6')
        expect(page.locator('#new-password')).to_have_attribute('maxlength', '12')
        page.locator('#current-password').fill(master)
        page.locator('#new-password').fill(next_master)
        page.locator('#new-password-confirm').fill(next_master)
        page.locator('button[form=password-form]').click()
        expect(page.locator('#auth-screen')).to_be_visible()
        expect(second_window.locator('#auth-screen')).to_be_visible()
        expect(page.locator('#toast-root')).to_contain_text('主密码已更新')
        for tab in [page, second_window]:
            assert tab.locator('#entries .entry-card').count() == 0
            assert tab.locator('#drawer-root input[type=password]').count() == 0
        page.locator('#auth-password').fill(master)
        page.locator('#auth-form button[type=submit]').click()
        expect(page.locator('#auth-error')).to_be_visible()
        page.locator('#auth-password').fill(next_master)
        page.locator('#auth-form button[type=submit]').click()
        expect(page.locator('#app-screen')).to_be_visible()
        print('PASS: delete, change master password, immediate cross-window lock, wrong-password feedback', flush=True)

        # 故意回收后台，再通过消息唤醒，验证密钥只依赖浏览器会话。
        cdp = ctx.new_cdp_session(page)
        targets = cdp.send('Target.getTargets')['targetInfos']
        worker_target = next(target for target in targets if target['type'] == 'service_worker' and target['url'] == base + 'background.js')
        cdp.send('Target.closeTarget', {'targetId': worker_target['targetId']})
        assert len(request('list')['entries']) == 6
        print('PASS: service-worker restart keeps unlocked browser session', flush=True)

        ctx.set_offline(True)
        page.reload()
        expect(page.locator('.entry-card')).to_have_count(6)
        assert request('codes')['codes']
        ctx.set_offline(False)
        assert not external, external
        assert not errors, errors
        print('PASS: offline UI and codes, no external requests or page errors', flush=True)
        ctx.close()

        ctx, restarted_base = launch()
        page = ctx.new_page()
        page.goto(restarted_base + 'popup.html')
        expect(page.locator('#auth-screen')).to_be_visible()
        expect(page.locator('#auth-title')).to_have_text('欢迎回来')
        assert page.locator('#entries .entry-card').count() == 0
        page.locator('#auth-password').fill(next_master)
        page.locator('#auth-form button[type=submit]').click()
        expect(page.locator('.entry-card')).to_have_count(6)
        print('PASS: browser restart locks and encrypted data persists', flush=True)
        ctx.close()
    print('Browser acceptance complete.', flush=True)


if __name__ == '__main__':
    run()
