"""用已发布旧包验证原目录覆盖升级、密码兼容和本地数据保留。"""
import json
import os
import re
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
CHROME = os.environ.get('CHROME_BIN', '/root/python/.playwright-browsers/chromium-1234/chrome-linux64/chrome')
PREVIOUS_ZIP = Path(os.environ.get('CREDMEMO_PREVIOUS_ZIP', str(ROOT / 'release/CredMemo-2.5.1.zip')))
PUBLIC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'


def run():
    expected_version = json.loads((ROOT / 'dist/manifest.json').read_text())['version']
    legacy_master, credential_password, backup_password = [str(uuid.uuid4()) for _ in range(3)]
    next_master = str(uuid.uuid4())[:6]
    with tempfile.TemporaryDirectory(prefix='credmemo-upgrade-') as folder, sync_playwright() as p:
        installed, profile = Path(folder) / 'installed', Path(folder) / 'profile'
        installed.mkdir()
        with zipfile.ZipFile(PREVIOUS_ZIP) as archive:
            assert archive.testzip() is None
            previous_version = json.loads(archive.read('manifest.json'))['version']
            assert previous_version in ('2.5.0', '2.5.1'), 'This legacy-password fixture requires v2.5.0 or v2.5.1'
            archive.extractall(installed)

        def launch(install=False):
            ctx = p.chromium.launch_persistent_context(str(profile), executable_path=CHROME, headless=True,
                ignore_default_args=['--disable-extensions'],
                args=['--no-sandbox', '--enable-unsafe-extension-debugging'],
                viewport={'width': 390, 'height': 600}, locale='zh-CN')
            ctx.set_default_timeout(12000)
            if install:
                ctx.browser.new_browser_cdp_session().send('Extensions.loadUnpacked', {'path': str(installed)})
            worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
            return ctx, worker.url.rsplit('/', 1)[0] + '/'

        ctx, base = launch(install=True)
        page = ctx.new_page()
        page.goto(base + 'popup.html')
        expect(page.locator('#auth-screen')).to_be_visible()
        assert page.evaluate('chrome.action.getUserSettings()') == {'isOnToolbar': False}
        assert page.evaluate('typeof chrome.action.setUserSettings') == 'undefined'
        page.locator('#auth-password').fill(legacy_master)
        page.locator('#confirm-password').fill(legacy_master)
        page.locator('#auth-form button[type=submit]').click()
        expect(page.locator('#app-screen')).to_be_visible()

        def request(action, args=None):
            response = page.evaluate('([action,args])=>chrome.runtime.sendMessage({type:"credmemo",action,args})', [action, args or {}])
            assert response['ok'], response.get('error')
            return response['data']

        entry = {'title': 'Upgrade fixture', 'url': 'https://example.test', 'logins': [
            {'username': 'fixture@example.test', 'password': credential_password}],
            'totps': [{'secret': PUBLIC_SECRET}]}
        saved = request('save', {'entry': entry})
        backup = request('backup', {'password': backup_password})
        encrypted = page.evaluate('chrome.storage.local.get("credmemo-vault")')
        assert credential_password not in json.dumps(encrypted)
        assert PUBLIC_SECRET not in json.dumps(encrypted)
        print(f'PASS: released {previous_version} stores encrypted credentials with a long legacy master password; fresh install is unpinned', flush=True)

        # 从发行 ZIP 覆盖原安装位置，避免新目录前缀造成嵌套安装。
        with zipfile.ZipFile(ROOT / f'release/CredMemo-{expected_version}.zip') as archive:
            assert archive.testzip() is None
            assert {name.split('/')[0] for name in archive.namelist()} == {'CredMemo'}
            unpacked = Path(folder) / 'download'
            archive.extractall(unpacked)
        shutil.copytree(unpacked / 'CredMemo', installed, dirs_exist_ok=True)
        manager = ctx.new_page()
        manager.goto('chrome://extensions/')
        developer_mode = manager.locator('extensions-toolbar #devMode')
        if not developer_mode.evaluate('node=>node.checked'):
            developer_mode.click()
        extension_id = base.split('/')[2]
        manager.locator(f'extensions-item[id="{extension_id}"] #dev-reload-button').click()
        manager.wait_for_function('([id,version])=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}).then(items=>items.some(item=>item.id===id&&item.version===version&&item.state==="ENABLED"))', arg=[extension_id, expected_version])
        page = ctx.new_page()
        page.goto(base + 'popup.html')
        expect(page.locator('#auth-screen')).to_be_visible()
        assert page.evaluate('chrome.runtime.getManifest().version') == expected_version
        assert page.evaluate('chrome.storage.local.get("credmemo-vault")') == encrypted
        assert page.evaluate('chrome.action.getUserSettings()') == {'isOnToolbar': False}
        expect(page.locator('#auth-password')).to_have_attribute('maxlength', '256')
        page.locator('#auth-password').fill(legacy_master)
        page.locator('#auth-form button[type=submit]').click()
        expect(page.locator('.entry-card')).to_have_count(1)
        assert request('get', {'id': saved['id']})['logins'][0]['password'] == credential_password
        expect(page.locator('.totp-code')).to_have_text(re.compile(r'\d{3} \d{3}'))
        print('PASS: same-directory reload upgrades the existing extension and preserves its ID, encrypted vault, long-password unlock and TOTP', flush=True)

        page.locator('.topbar [data-action=transfer]').click()
        page.locator('[data-action=transfer-tab][data-tab=export]').click()
        page.locator('#export-password').fill(legacy_master)
        expect(page.locator('#export-password')).to_have_attribute('minlength', '6')
        assert page.locator('#export-form').evaluate('node=>node.checkValidity()')
        assert request('export', {'password': legacy_master})['entries'][0]['logins'][0]['password'] == credential_password
        page.locator('#modal-root [data-action=close-modal]').first.click()
        page.locator('.topbar [data-action=settings]').click()
        page.locator('[data-action=change-password]').click()
        expect(page.locator('#current-password')).to_be_focused()
        page.locator('#current-password').fill(legacy_master)
        page.locator('#new-password').fill(next_master)
        page.locator('#new-password-confirm').fill(next_master)
        expect(page.locator('#new-password')).to_have_attribute('maxlength', '12')
        page.locator('button[form=password-form]').click()
        expect(page.locator('#auth-screen')).to_be_visible()
        page.locator('#auth-password').fill(next_master)
        page.locator('#auth-form button[type=submit]').click()
        expect(page.locator('.entry-card')).to_have_count(1)
        assert request('restore', {'password': backup_password, 'backup': backup})['imported'] == 1
        assert request('get', {'id': saved['id']})['logins'][0]['password'] == credential_password
        assert request('export', {'password': next_master})['entries'][0]['logins'][0]['password'] == credential_password
        print('PASS: legacy master verifies exports and password changes; a 6-character master unlocks and exports; old encrypted backup restores', flush=True)
        ctx.close()

        ctx, restarted_base = launch()
        assert restarted_base == base
        page = ctx.new_page()
        page.goto(base + 'popup.html')
        expect(page.locator('#auth-screen')).to_be_visible()
        page.locator('#auth-password').fill(next_master)
        page.locator('#auth-form button[type=submit]').click()
        expect(page.locator('.entry-card')).to_have_count(2)
        assert request('get', {'id': saved['id']})['logins'][0]['password'] == credential_password
        expect(page.locator('.totp-code').first).to_have_text(re.compile(r'\d{3} \d{3}'))
        print('PASS: upgraded credentials and the new master password survive a browser restart', flush=True)

        # 不同加载路径用于复现重复安装，不能把新的空凭证库当作升级结果。
        duplicate = Path(folder) / f'CredMemo-{expected_version}'
        shutil.copytree(ROOT / 'dist', duplicate)
        loaded = ctx.browser.new_browser_cdp_session().send('Extensions.loadUnpacked', {'path': str(duplicate)})
        assert loaded['id'] != extension_id
        duplicate_page = ctx.new_page()
        duplicate_page.goto(f'chrome-extension://{loaded["id"]}/popup.html')
        expect(duplicate_page.locator('#confirm-password')).to_be_visible()
        assert duplicate_page.evaluate('chrome.storage.local.get("credmemo-vault")') == {}
        assert request('get', {'id': saved['id']})['logins'][0]['password'] == credential_password
        ctx.close()
        print('PASS: loading the same build from another directory creates a distinct ID and empty vault; the original vault remains intact', flush=True)


if __name__ == '__main__':
    run()
