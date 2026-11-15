"""一体搜索、精简表单及导入备份布局验收，使用临时配置及随机凭证。"""
import json
import tempfile
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from fill_acceptance import CHROME

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'release/screenshots'


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    errors = []
    with tempfile.TemporaryDirectory(prefix='credmemo-ui-') as profile, sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True,
            args=['--no-sandbox', f'--disable-extensions-except={ROOT / "dist"}', f'--load-extension={ROOT / "dist"}'],
            viewport={'width': 360, 'height': 560}, locale='zh-CN')
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
        base = worker.url.rsplit('/', 1)[0] + '/'
        page = ctx.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(base + 'popup.html')
        expect(page.locator('#auth-screen')).to_be_visible()

        def request(action, args=None):
            result = page.evaluate('([action,args])=>chrome.runtime.sendMessage({type:"credmemo",action,args})', [action, args or {}])
            assert result['ok'], result.get('error')
            return result['data']

        master, backup_password = str(uuid.uuid4())[:12], str(uuid.uuid4())
        request('initialize', {'password': master})
        for title, username in [('Example Mail', 'mail@example.test'), ('Example Work', 'work@example.test')]:
            entry = {'title': title, 'url': 'https://example.test', 'logins': [{'username': username, 'password': str(uuid.uuid4())}]}
            if username.startswith('mail'):
                entry['totps'] = [{'secret': 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'}]
            request('save', {'entry': entry})
        page.reload()
        expect(page.locator('.entry-card')).to_have_count(2)
        expect(page.locator('#page-title,[data-action=site-filter]')).to_have_count(0)
        expect(page.locator('#search-panel')).to_be_hidden()
        buttons = page.locator('.heading-actions .button').evaluate_all('items=>items.map(node=>({width:node.offsetWidth,height:node.offsetHeight,label:node.getAttribute("aria-label")}))')
        assert len(buttons) == 3 and all(item['width'] == 28 and item['height'] == 28 and item['label'] for item in buttons)
        assert page.locator('.heading-actions .button').evaluate_all('items=>items.map(node=>node.dataset.action)') == ['search-toggle', 'new', 'scan-page']
        row_top = page.locator('.heading-actions').bounding_box()['y']
        page.locator('[data-action=search-toggle]').click()
        expect(page.locator('#search')).to_be_focused()
        assert page.locator('#search-panel').bounding_box()['y'] == row_top
        assert page.locator('.heading-actions').bounding_box()['height'] == 28
        assert page.locator('#search-panel').evaluate('node=>node.clientWidth>=200&&node.scrollWidth<=node.clientWidth')
        assert page.locator('[data-action=search-toggle]').evaluate('node=>node.closest(".search-control")===document.querySelector("#search-panel").parentElement&&getComputedStyle(node).borderLeftWidth==="0px"')
        toggle = page.locator('[data-action=search-toggle]').bounding_box()
        assert toggle['x'] + toggle['width'] == page.locator('#search-panel').bounding_box()['x']
        page.screenshot(path=str(OUT / 'inline-search.png'), animations='disabled')
        page.locator('#search').fill('MAIL@')
        expect(page.locator('.entry-card')).to_have_count(1)
        page.keyboard.press('Escape')
        expect(page.locator('#search-panel')).to_be_hidden()
        expect(page.locator('.entry-card')).to_have_count(2)
        expect(page.locator('[data-action=search-toggle]')).to_be_focused()
        page.keyboard.press('/')
        expect(page.locator('#search')).to_be_focused()
        page.locator('[data-action=search-close]').click()
        page.screenshot(path=str(OUT / 'compact-list.png'), animations='disabled')
        page.locator('[data-action=new]').first.click()
        expect(page.locator('.token-type')).to_be_hidden()
        expect(page.locator('.token-heading select')).to_have_count(0)
        expect(page.locator('.token-type')).to_have_value('totp')
        page.screenshot(path=str(OUT / 'new-credential.png'), animations='disabled')
        page.locator('#modal-root [data-action=close-modal]').first.focus()
        page.keyboard.press('/')
        expect(page.locator('#search-panel')).to_be_hidden()
        assert page.evaluate('document.querySelector(".modal").contains(document.activeElement)')
        page.keyboard.press('Escape')
        page.locator('#entries [data-action=show-qr]').click()
        page.wait_for_function('()=>{const canvas=document.querySelector("#totp-qr");return canvas&&canvas.width>=200&&canvas.width<=216}')
        page.screenshot(path=str(OUT / 'binding-qr.png'), animations='disabled')
        page.locator('#modal-root [data-action=close-modal]').click()
        print('PASS: three compact icons; integrated search expands within the same row; 2FA type stays behind its settings button', flush=True)

        def transfer(tab):
            page.locator('.topbar [data-action=transfer]').click()
            if tab != 'backup':
                page.locator(f'[data-action=transfer-tab][data-tab={tab}]').click()

        def layout():
            assert page.evaluate('document.documentElement.scrollWidth===360')
            assert page.locator('.modal').evaluate('node=>node.getBoundingClientRect().width<=328&&node.getBoundingClientRect().height<=430')
            assert page.locator('.modal-body').evaluate('node=>node.scrollWidth<=node.clientWidth&&node.scrollHeight<=node.clientHeight+1')
            for button in page.locator('.transfer-actions button').all():
                assert button.evaluate('node=>node.getBoundingClientRect().bottom<=document.querySelector(".modal-body").getBoundingClientRect().bottom')

        for language in ['zh', 'en']:
            if page.locator('html').get_attribute('lang') != ('zh-CN' if language == 'zh' else 'en'):
                page.locator('.topbar [data-action=language]').click()
            for theme in ['light', 'dark']:
                if page.locator('html').get_attribute('data-theme') != theme:
                    page.locator('.topbar [data-action=theme]').click()
                expect(page.locator('#toast-root')).to_be_empty()
                page.locator('[data-action=search-toggle]').click()
                assert page.locator('.heading-actions').evaluate('node=>node.scrollWidth<=node.clientWidth&&node.offsetHeight===28')
                page.screenshot(path=str(OUT / f'inline-search-{language}-{theme}.png'), animations='disabled')
                page.locator('[data-action=search-close]').click()
                page.locator('[data-action=new]').first.click()
                expect(page.locator('.token-type')).to_be_hidden()
                assert page.locator('.modal-body').evaluate('node=>node.scrollHeight<=node.clientHeight+1&&node.scrollWidth<=node.clientWidth')
                page.locator('[data-action=token-options]').click()
                expect(page.locator('.token-type')).to_be_focused()
                expect(page.locator('[data-action=token-options]')).to_have_attribute('aria-expanded', 'true')
                assert page.locator('.advanced-options').evaluate('node=>node.scrollWidth<=node.clientWidth')
                assert page.locator('.advanced-options').evaluate('node=>{const panel=node.getBoundingClientRect(),body=node.closest(".modal-body").getBoundingClientRect();return panel.top>=body.top-1&&panel.bottom<=body.bottom+1}')
                page.screenshot(path=str(OUT / f'token-settings-{language}-{theme}.png'), animations='disabled')
                page.locator('[data-action=token-options]').click()
                expect(page.locator('.token-type')).to_be_hidden()
                expect(page.locator('[data-action=token-options]')).to_have_attribute('aria-expanded', 'false')
                page.locator('#modal-root .modal-header [data-action=close-modal]').click()
                for tab in ['backup', 'import', 'export']:
                    transfer(tab)
                    layout()
                    expect(page.locator(f'[data-tab={tab}]')).to_have_attribute('aria-pressed', 'true')
                    if tab == 'import':
                        expect(page.locator('#import-submit')).to_be_disabled()
                    page.screenshot(path=str(OUT / f'transfer-{tab}-{language}-{theme}.png'), animations='disabled')
                    page.locator('#modal-root [data-action=close-modal]').click()
        print('PASS: backup/import/export layouts fit at 360px in both languages and themes, with actions visible without scrolling', flush=True)

        exported = request('export', {'password': master})
        encrypted = request('backup', {'password': backup_password})
        transfer('import')
        filename = 'backup-' + 'fixture-' * 20 + '.credmemo'
        page.locator('#import-file').set_input_files({'name': filename, 'mimeType': 'application/json', 'buffer': json.dumps(encrypted).encode()})
        expect(page.locator('#restore-password-field')).to_be_visible()
        expect(page.locator('#import-submit')).to_be_enabled()
        expect(page.locator('#file-name')).to_have_attribute('title', filename)
        assert page.locator('#file-name').evaluate('node=>node.getBoundingClientRect().height<=34')
        layout()
        page.locator('#import-file').set_input_files({'name': 'fixture.json', 'mimeType': 'application/json', 'buffer': json.dumps(exported).encode()})
        expect(page.locator('#restore-password-field')).to_be_hidden()
        expect(page.locator('#import-submit')).to_be_enabled()
        page.locator('#import-file').set_input_files({'name': 'invalid.json', 'mimeType': 'application/json', 'buffer': b'{invalid'})
        expect(page.locator('#transfer-error')).to_be_visible()
        expect(page.locator('#import-submit')).to_be_disabled()
        assert len(request('list')['entries']) == 2
        page.locator('#modal-root [data-action=close-modal]').click()

        transfer('import')
        # 模拟文件仍在读取时切换面板，完成后不能回写已关闭的表单。
        page.evaluate('()=>{window.originalRead=File.prototype.text;File.prototype.text=function(){return new Promise(resolve=>window.finishRead=()=>resolve(JSON.stringify({format:"credmemo-export",version:1,entries:[]})))}}')
        page.locator('#import-file').set_input_files({'name': 'pending.json', 'mimeType': 'application/json', 'buffer': b'{}'})
        page.locator('[data-tab=backup]').click()
        page.evaluate('()=>{window.finishRead();File.prototype.text=window.originalRead}')
        expect(page.locator('#backup-form')).to_be_visible()
        expect(page.locator('#import-form')).to_have_count(0)
        page.locator('#modal-root [data-action=close-modal]').click()
        page.locator('[data-action=search-toggle]').click()
        page.locator('#search').fill('mail')
        request('lock')
        expect(page.locator('#auth-screen')).to_be_visible()
        expect(page.locator('#search-panel')).to_be_hidden()
        expect(page.locator('#search')).to_have_value('')
        assert not errors, errors
        print('PASS: file type switches, invalid files, pending reads and locking leave no stale data or page errors', flush=True)
        ctx.close()


if __name__ == '__main__':
    run()
