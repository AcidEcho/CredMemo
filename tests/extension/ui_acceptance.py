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
            viewport={'width': 315, 'height': 560}, locale='zh-CN')
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

        def toolbar_palette():
            toolbar = page.locator('.heading-actions .button,.topbar-actions>.icon-button')
            page.locator('.main-content').hover(position={'x': 3, 'y': 3})
            styles = toolbar.evaluate_all('async items=>{await Promise.all(items.flatMap(node=>node.getAnimations()).map(animation=>animation.finished));return items.map(node=>{const s=getComputedStyle(node);return {color:s.color,background:s.backgroundColor}})}')
            assert len(styles) == 5 and all(style == styles[-1] for style in styles)
            assert styles[-1]['background'] == 'rgba(0, 0, 0, 0)'
            hovered = []
            for button in toolbar.all():
                before = button.bounding_box()
                button.hover()
                assert button.bounding_box() == before
                hovered.append(button.evaluate('async node=>{await Promise.all(node.getAnimations().map(animation=>animation.finished));const s=getComputedStyle(node);return {color:s.color,background:s.backgroundColor}}'))
            assert all(style == hovered[-1] for style in hovered)
            page.locator('.main-content').hover(position={'x': 3, 'y': 3})

        master, backup_password = str(uuid.uuid4())[:12], str(uuid.uuid4())
        request('initialize', {'password': master})
        page.reload()
        for scheme in ['light', 'dark']:
            page.emulate_media(color_scheme=scheme)
            expect(page.locator('html')).to_have_attribute('data-theme', scheme)
            expect(page.locator('#empty-state')).to_be_visible()
            expect(page.locator('#empty-state .empty-icon use')).to_have_attribute('href', '/static/icons.svg#credential')
            toolbar_palette()
            page.screenshot(path=str(OUT / f'empty-state-{scheme}.png'), animations='disabled')
            page.locator('#empty-state [data-action=new]').click()
            expect(page.locator('#entry-form')).to_be_visible()
            page.locator('#modal-root [data-action=close-modal]').first.click()
        page.emulate_media(color_scheme='light')
        print('PASS: credential empty-state icon; five neutral toolbar buttons share default and hover colors in both themes', flush=True)
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
        assert len(buttons) == 3 and all(item['width'] == 26 and item['height'] == 28 and item['label'] for item in buttons)
        assert page.locator('.heading-actions .button').evaluate_all('items=>items.map(node=>node.dataset.action)') == ['search-toggle', 'new', 'scan-page']
        assert page.locator('.topbar-actions>button').evaluate_all('items=>items.map(node=>node.dataset.action)') == ['lock', 'toolbar-menu']
        assert page.locator('.heading-actions').evaluate('node=>!!node.closest(".topbar")')
        expect(page.locator('.page-heading')).to_have_count(0)
        expect(page.locator('[data-action=settings],#theme-select,#language-select')).to_have_count(0)
        assert page.locator('#toolbar-menu>button').evaluate_all('items=>items.map(node=>node.dataset.action)') == ['transfer', 'language', 'theme-options', 'change-password']
        expect(page.locator('[data-action=lock]')).to_have_count(1)
        expect(page.locator('#toolbar-menu')).to_be_hidden()
        page.locator('#toolbar-more').click()
        expect(page.locator('#toolbar-menu')).to_be_visible()
        expect(page.locator('#toolbar-more')).to_have_attribute('aria-expanded', 'true')
        page.keyboard.press('Escape')
        expect(page.locator('#toolbar-more')).to_be_focused()
        expect(page.locator('#toolbar-menu')).to_be_hidden()
        page.keyboard.press('ArrowDown')
        expect(page.locator('#toolbar-menu [data-action=transfer]')).to_be_focused()
        page.keyboard.press('End')
        expect(page.locator('#toolbar-menu [data-action=change-password]')).to_be_focused()
        page.keyboard.press('ArrowDown')
        expect(page.locator('#toolbar-menu [data-action=transfer]')).to_be_focused()
        page.keyboard.press('ArrowUp')
        expect(page.locator('#toolbar-menu [data-action=change-password]')).to_be_focused()
        page.keyboard.press('Tab')
        expect(page.locator('#toolbar-menu')).to_be_hidden()
        page.locator('#toolbar-more').click()
        page.locator('.main-content').click(position={'x': 3, 'y': 3})
        expect(page.locator('#toolbar-menu')).to_be_hidden()
        page.locator('#toolbar-more').click()
        page.locator('#toolbar-menu [data-action=change-password]').click()
        expect(page.locator('#current-password')).to_be_focused()
        expect(page.locator('#modal-title')).to_have_text('修改主密码')
        page.locator('#modal-root [data-action=close-modal]').first.click()
        expect(page.locator('#toolbar-more')).to_be_focused()

        def choose_theme(value):
            page.locator('#toolbar-more').click()
            page.locator('[data-action=theme-options]').click()
            page.locator(f'[data-action=set-theme][data-theme={value}]').click()
            expect(page.locator('#toolbar-menu')).to_be_hidden()
            expect(page.locator('#toolbar-theme-options')).to_be_hidden()
            expect(page.locator('#toolbar-more')).to_be_focused()
            assert page.evaluate('localStorage.getItem("credmemo-theme")') == value

        page.locator('#toolbar-more').click()
        page.locator('[data-action=theme-options]').focus()
        page.keyboard.press('ArrowRight')
        expect(page.locator('#toolbar-theme-options')).to_be_visible()
        expect(page.locator('[data-action=set-theme][data-theme=system]')).to_be_focused()
        page.keyboard.press('ArrowUp')
        expect(page.locator('[data-action=set-theme][data-theme=dark]')).to_be_focused()
        page.keyboard.press('Enter')
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        choose_theme('system')
        for scheme in ['light', 'dark']:
            page.emulate_media(color_scheme=scheme)
            expect(page.locator('html')).to_have_attribute('data-theme', scheme)
            page.locator('#toolbar-more').click()
            expect(page.locator('#toolbar-theme')).to_have_text('跟随系统')
            page.locator('[data-action=theme-options]').click()
            expect(page.locator('[data-action=set-theme][data-theme=system]')).to_have_attribute('aria-checked', 'true')
            assert page.locator('#toolbar-theme-options [aria-checked=true]').count() == 1
            assert page.locator('#toolbar-menu').evaluate('node=>{const r=node.getBoundingClientRect();return node.scrollWidth<=node.clientWidth&&r.bottom<=innerHeight}')
            page.screenshot(path=str(OUT / f'toolbar-system-{scheme}.png'), animations='disabled')
            page.keyboard.press('ArrowLeft')
            expect(page.locator('[data-action=theme-options]')).to_be_focused()
            expect(page.locator('#toolbar-theme-options')).to_be_hidden()
            page.keyboard.press('ArrowDown')
            expect(page.locator('#toolbar-menu [data-action=change-password]')).to_be_focused()
            page.keyboard.press('Escape')
        page.reload()
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        assert page.evaluate('localStorage.getItem("credmemo-theme")') == 'system'
        choose_theme('light')
        page.emulate_media(color_scheme='dark')
        expect(page.locator('html')).to_have_attribute('data-theme', 'light')
        page.emulate_media(color_scheme='light')
        page.locator('#toolbar-more').click()
        page.locator('[data-action=theme-options]').click()
        page.keyboard.press('Escape')
        expect(page.locator('#toolbar-menu')).to_be_visible()
        expect(page.locator('[data-action=theme-options]')).to_be_focused()
        page.keyboard.press('Escape')
        expect(page.locator('#toolbar-menu')).to_be_hidden()
        print('PASS: preferences removed; direct password entry; three theme choices persist, follow system changes and support keyboard dismissal', flush=True)
        assert page.locator('.results-line').bounding_box()['y'] >= page.locator('#entries').bounding_box()['y'] + page.locator('#entries').bounding_box()['height']
        row_top = page.locator('.heading-actions').bounding_box()['y']
        page.locator('[data-action=search-toggle]').click()
        expect(page.locator('#search')).to_be_focused()
        assert page.locator('#search-panel').bounding_box()['y'] == row_top
        assert page.locator('.heading-actions').bounding_box()['height'] == 28
        assert page.locator('#search-panel').evaluate('node=>node.clientWidth>=120&&node.scrollWidth<=node.clientWidth')
        expect(page.locator('.popup-brand')).to_be_hidden()
        assert page.locator('[data-action=search-toggle]').evaluate('node=>node.closest(".search-control")===document.querySelector("#search-panel").parentElement&&getComputedStyle(node).borderLeftWidth==="0px"')
        toggle = page.locator('[data-action=search-toggle]').bounding_box()
        assert toggle['x'] + toggle['width'] == page.locator('#search-panel').bounding_box()['x']
        page.screenshot(path=str(OUT / 'inline-search.png'), animations='disabled')
        page.locator('#search').fill('MAIL@')
        expect(page.locator('.entry-card')).to_have_count(1)
        expect(page.locator('#results-count')).to_have_text('1 条凭证')
        page.locator('#search').fill('No matching fixture')
        expect(page.locator('#empty-state')).to_be_visible()
        expect(page.locator('#empty-state .empty-icon use')).to_have_attribute('href', '/static/icons.svg#search')
        expect(page.locator('#results-count')).to_have_text('0 条凭证')
        assert page.locator('.results-line').bounding_box()['y'] >= page.locator('#empty-state').bounding_box()['y'] + page.locator('#empty-state').bounding_box()['height']
        page.keyboard.press('Escape')
        expect(page.locator('#search-panel')).to_be_hidden()
        expect(page.locator('.entry-card')).to_have_count(2)
        expect(page.locator('[data-action=search-toggle]')).to_be_focused()
        expect(page.locator('.popup-brand')).to_be_visible()
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
            page.locator('#toolbar-more').click()
            page.locator('.topbar [data-action=transfer]').click()
            if tab != 'backup':
                page.locator(f'[data-action=transfer-tab][data-tab={tab}]').click()

        def layout():
            assert page.evaluate('document.documentElement.scrollWidth===315')
            assert page.locator('.modal').evaluate('node=>node.getBoundingClientRect().width<=328&&node.getBoundingClientRect().height<=430')
            assert page.locator('.modal-body').evaluate('node=>node.scrollWidth<=node.clientWidth&&node.scrollHeight<=node.clientHeight+1')
            for button in page.locator('.transfer-actions button').all():
                assert button.evaluate('node=>node.getBoundingClientRect().bottom<=document.querySelector(".modal-body").getBoundingClientRect().bottom')

        def settings_layout():
            controls = page.locator('.advanced-options [data-field]:visible').evaluate_all('items=>items.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})')
            assert len(controls) == 4
            assert len({item['height'] for item in controls}) == 1
            assert controls[0]['y'] == controls[1]['y'] and controls[2]['y'] == controls[3]['y']
            assert controls[0]['x'] == controls[2]['x'] and controls[1]['x'] == controls[3]['x']
            assert abs(controls[0]['width'] - controls[1]['width']) <= 1

        def input_buttons_fit():
            assert page.locator('#modal-root .input-wrap').evaluate_all('wraps=>wraps.every(wrap=>{const r=wrap.getBoundingClientRect(),buttons=[...wrap.querySelectorAll("button")].map(button=>button.getBoundingClientRect());return buttons.every((button,index)=>button.left>=r.left&&button.right<=r.right&&button.top>=r.top&&button.bottom<=r.bottom&&(!index||buttons[index-1].right<=button.left))})')

        def error_feedback():
            assert page.locator('#form-error').evaluate('node=>{const r=node.getBoundingClientRect(),modal=node.closest(".modal").getBoundingClientRect(),x=r.left+r.width/2;return r.top>=modal.top&&r.bottom<=modal.bottom&&r.top>=0&&r.bottom<=innerHeight&&[r.top+2,r.bottom-2].every(y=>node.contains(document.elementFromPoint(x,y)))}'), 'Validation feedback is clipped or covered'
            assert page.locator('button[form=entry-form]').evaluate('node=>{const r=node.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}')

        for language in ['zh', 'en']:
            if page.locator('html').get_attribute('lang') != ('zh-CN' if language == 'zh' else 'en'):
                page.locator('#toolbar-more').click()
                page.locator('.topbar [data-action=language]').click()
            for theme in ['light', 'dark']:
                if page.locator('html').get_attribute('data-theme') != theme:
                    choose_theme(theme)
                expect(page.locator('#toast-root')).to_be_empty()
                page.locator('#toolbar-more').click()
                expect(page.locator('#toolbar-language')).to_have_text('简体中文' if language == 'zh' else 'English')
                expect(page.locator('#toolbar-theme')).to_have_text(('浅色' if theme == 'light' else '深色') if language == 'zh' else theme.capitalize())
                assert page.locator('#toolbar-menu').evaluate('node=>{const r=node.getBoundingClientRect();return node.scrollWidth<=node.clientWidth&&r.left>=0&&r.right<=innerWidth}')
                page.screenshot(path=str(OUT / f'toolbar-menu-{language}-{theme}.png'), animations='disabled')
                page.keyboard.press('Escape')
                toolbar_palette()
                for action in ['edit', 'delete', 'copy-username', 'reveal-card', 'copy-code', 'show-qr']:
                    button = page.locator(f'#entries [data-action={action}]').first
                    before = button.bounding_box()
                    button.hover()
                    assert button.bounding_box() == before
                    if action in ['edit', 'delete']:
                        page.screenshot(path=str(OUT / f'hover-{action}-{language}-{theme}.png'), animations='disabled')
                page.locator('#entries [data-action=edit]').first.focus()
                page.keyboard.press('Tab')
                assert page.locator('#entries [data-action=delete]').first.evaluate('node=>node.matches(":focus-visible")&&parseFloat(getComputedStyle(node).outlineWidth)>0')
                page.locator('[data-action=search-toggle]').click()
                assert page.locator('.heading-actions').evaluate('node=>node.scrollWidth<=node.clientWidth&&node.offsetHeight===28')
                page.screenshot(path=str(OUT / f'inline-search-{language}-{theme}.png'), animations='disabled')
                page.locator('[data-action=search-close]').click()
                page.locator('[data-action=new]').first.click()
                expect(page.locator('.token-type')).to_be_hidden()
                assert page.locator('.modal-body').evaluate('node=>node.scrollHeight<=node.clientHeight+1&&node.scrollWidth<=node.clientWidth')
                input_buttons_fit()
                page.locator('.token-item [data-action=toggle-password]').hover()
                page.screenshot(path=str(OUT / f'hover-secret-{language}-{theme}.png'), animations='disabled')
                page.locator('[data-action=token-options]').click()
                expect(page.locator('.token-type')).to_be_focused()
                expect(page.locator('[data-action=token-options]')).to_have_attribute('aria-expanded', 'true')
                assert page.locator('.advanced-options').evaluate('node=>node.scrollWidth<=node.clientWidth')
                assert page.locator('.advanced-options').evaluate('node=>{const panel=node.getBoundingClientRect(),body=node.closest(".modal-body").getBoundingClientRect();return panel.top>=body.top-1&&panel.bottom<=body.bottom+1}')
                settings_layout()
                input_buttons_fit()
                page.locator('[data-action=token-options]').hover()
                page.screenshot(path=str(OUT / f'token-settings-{language}-{theme}.png'), animations='disabled')
                page.locator('[data-action=token-options]').click()
                expect(page.locator('.token-type')).to_be_hidden()
                expect(page.locator('[data-action=token-options]')).to_have_attribute('aria-expanded', 'false')
                page.locator('#entry-title').fill('Validation fixture')
                page.locator('button[form=entry-form]').click()
                expect(page.locator('#form-error')).to_have_text('至少添加一组账号密码或 2FA' if language == 'zh' else 'Add at least one account or 2FA key')
                page.screenshot(path=str(OUT / f'validation-missing-{language}-{theme}.png'), animations='disabled')
                error_feedback()
                expect(page.locator('#entry-title')).to_have_value('Validation fixture')
                assert len(request('list')['entries']) == 2

                password = str(uuid.uuid4())
                page.locator('.login-item [data-field=username]').fill('validation@example.test')
                page.locator('.login-item [data-field=password]').fill(password)
                page.locator('#entry-notes').fill('Preserve these unsaved fields')
                page.locator('#entry-url').fill('https://invalid host.test')
                page.locator('button[form=entry-form]').click()
                expect(page.locator('#form-error')).to_have_text('请输入有效网站地址' if language == 'zh' else 'Enter a valid website URL')
                error_feedback()

                page.locator('#entry-url').fill('')
                page.locator('.token-item [data-field=secret]').fill('invalid 2FA fixture')
                page.locator('[data-action=token-options]').click()
                page.locator('.modal-body').evaluate('node=>node.scrollTop=0')
                page.locator('button[form=entry-form]').click()
                expect(page.locator('#form-error')).to_have_text('2FA 密钥或参数无效' if language == 'zh' else 'Invalid 2FA secret or parameters')
                error_feedback()
                expect(page.locator('.login-item [data-field=password]')).to_have_value(password)
                expect(page.locator('#entry-notes')).to_have_value('Preserve these unsaved fields')
                assert len(request('list')['entries']) == 2

                page.locator('.token-item [data-field=secret]').fill('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
                page.locator('button[form=entry-form]').click()
                expect(page.locator('#modal-root')).to_be_empty()
                saved = next(entry for entry in request('list')['entries'] if entry['title'] == 'Validation fixture')
                assert request('get', {'id': saved['id']})['logins'][0]['password'] == password
                page.locator(f'[data-entry="{saved["id"]}"] [data-action=edit]').click()
                page.locator('#entry-url').click()
                page.locator('#entry-url').fill('https://invalid host.test')
                expect(page.locator('#entry-url')).to_have_value('https://invalid host.test')
                page.locator('button[form=entry-form]').click()
                expect(page.locator('#form-error')).to_have_text('请输入有效网站地址' if language == 'zh' else 'Enter a valid website URL')
                error_feedback()
                expect(page.locator('.login-item [data-field=password]')).to_have_value(password)
                assert request('get', {'id': saved['id']})['url'] == ''
                page.locator('#modal-root [data-action=close-modal]').first.click()
                request('delete', {'id': saved['id'], 'version': saved['version']})
                page.reload()
                expect(page.locator('.entry-card')).to_have_count(2)
                for tab in ['backup', 'import', 'export']:
                    transfer(tab)
                    layout()
                    expect(page.locator(f'[data-tab={tab}]')).to_have_attribute('aria-pressed', 'true')
                    if tab == 'import':
                        expect(page.locator('#import-submit')).to_be_disabled()
                    page.screenshot(path=str(OUT / f'transfer-{tab}-{language}-{theme}.png'), animations='disabled')
                    page.locator('#modal-root [data-action=close-modal]').click()
        print('PASS: validation errors stay visible without scrolling, preserve unsaved fields and allow correction in both languages and themes', flush=True)
        print('PASS: aligned 2FA settings, contained hover targets, visible keyboard focus and transfer layouts', flush=True)

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
        page.locator('#toolbar-more').click()
        request('lock')
        expect(page.locator('#auth-screen')).to_be_visible()
        expect(page.locator('#search-panel')).to_be_hidden()
        expect(page.locator('#search')).to_have_value('')
        expect(page.locator('#toolbar-menu')).to_be_hidden()
        expect(page.locator('#toolbar-more')).to_have_attribute('aria-expanded', 'false')
        assert not errors, errors
        print('PASS: file type switches, invalid files, pending reads and locking leave no stale data or page errors', flush=True)
        ctx.close()


if __name__ == '__main__':
    run()
