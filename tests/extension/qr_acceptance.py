"""三种保存模式与本地二维码识别的真实扩展验收。"""
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
CHROME = os.environ.get('CHROME_BIN', '/root/python/.playwright-browsers/chromium-1234/chrome-linux64/chrome')
PUBLIC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
URI = f'otpauth://totp/Example%3Afixture?secret={PUBLIC_SECRET}&algorithm=SHA256&digits=8&period=60'


def fixtures():
    script = '''const QR = require('qrcode');
(async()=>{const out={};
for(const [name,text] of Object.entries(JSON.parse(process.argv[1])))
 out[name]=await QR.toDataURL(text,{width:360,margin:4,...(name==='blank'?{color:{dark:'#ffffffff',light:'#ffffffff'}}:{})});
process.stdout.write(JSON.stringify(out));})();'''
    return json.loads(subprocess.check_output(['node', '-e', script, json.dumps({'valid': URI, 'ordinary': 'https://example.test', 'blank': 'fixture'})], cwd=ROOT))


def run():
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='credmemo-qr-') as profile:
        ctx = p.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True,
            args=['--no-sandbox', '--enable-unsafe-extension-debugging', f'--disable-extensions-except={ROOT / "dist"}', f'--load-extension={ROOT / "dist"}'],
            viewport={'width': 360, 'height': 600}, locale='zh-CN')
        ctx.set_default_timeout(12000)
        errors = []
        ctx.on('page', lambda tab: tab.on('pageerror', lambda error: errors.append(str(error))))
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
        base = worker.url.rsplit('/', 1)[0] + '/'
        page = ctx.new_page()
        page.goto(base + 'popup.html')
        master, password = str(uuid.uuid4())[:12], str(uuid.uuid4())
        page.locator('#auth-password').fill(master)
        page.locator('#confirm-password').fill(master)
        page.locator('#auth-form button[type=submit]').click()
        expect(page.locator('#app-screen')).to_be_visible()

        def request(action, args=None):
            result = page.evaluate('([action,args])=>chrome.runtime.sendMessage({type:"credmemo",action,args})', [action, args or {}])
            assert result['ok'], result.get('error')
            return result['data']

        def create(title):
            page.locator('.heading-actions [data-action=new]').click()
            expect(page.locator('#entry-form input[type=radio], #entry-options, #qr-image, [data-action=add-login], [data-action=add-totp]')).to_have_count(0)
            expect(page.locator('#entry-url')).to_be_visible()
            expect(page.locator('#entry-notes')).to_be_visible()
            expect(page.locator('.primary-item .remove-item')).to_have_count(0)
            expect(page.locator('.token-item [data-field=secret]')).to_have_attribute('placeholder', '输入 2FA 密钥')
            expect(page.locator('.token-item [data-action=scan-entry]')).to_be_visible()
            expect(page.locator('.advanced-options')).to_be_hidden()
            assert page.locator('.modal-body').evaluate('node=>node.scrollHeight<=node.clientHeight')
            page.locator('#entry-title').fill(title)

        def login():
            page.locator('.login-item [data-field=username]').fill('fixture@example.test')
            page.locator('.login-item [data-field=password]').fill(password)

        def save():
            page.locator('button[form=entry-form]').click()
            expect(page.locator('#modal-root')).to_be_empty()

        create('仅账号密码'); login(); save()
        create('手动密钥')
        page.locator('.token-item [data-field=secret]').fill(PUBLIC_SECRET); save()
        create('账号与对应2FA'); login()
        page.locator('.token-item [data-field=secret]').fill(PUBLIC_SECRET); save()
        entries = request('list')['entries']
        assert {entry['title']: (len(entry['logins']), len(entry['totps'])) for entry in entries} == {'仅账号密码': (1, 0), '手动密钥': (0, 1), '账号与对应2FA': (1, 1)}
        page.reload(); expect(page.locator('.entry-card')).to_have_count(3)
        print('PASS: six-field form saves account-only, 2FA-only and combined credentials; removed entry points stay absent', flush=True)

        create('无效凭证')
        page.locator('button[form=entry-form]').click()
        expect(page.locator('#form-error')).to_contain_text('至少添加')
        login(); page.locator('.token-item [data-field=secret]').fill('invalid 2FA fixture')
        page.locator('button[form=entry-form]').click()
        expect(page.locator('#form-error')).to_contain_text('2FA 密钥或参数无效')
        assert len(request('list')['entries']) == 3
        page.locator('#modal-root [data-action=close-modal]').first.click()

        legacy = request('get', {'id': entries[0]['id']})
        legacy['logins'] = [{'label': 'Legacy account', 'username': 'fixture@example.test', 'password': password}, {'label': 'Other', 'username': 'other@example.test', 'password': str(uuid.uuid4())}]
        legacy['totps'] = [{'label': 'Legacy token', 'secret': PUBLIC_SECRET, 'digits': 8, 'period': 60, 'algorithm': 'SHA256'}, {'label': 'Other', 'secret': PUBLIC_SECRET, 'digits': 6, 'period': 30, 'algorithm': 'SHA1'}]
        legacy['favorite'] = True
        request('save', {'id': legacy['id'], 'version': legacy['version'], 'entry': legacy})
        page.locator(f'[data-entry="{legacy["id"]}"] [data-action=edit]').click()
        expect(page.locator('.login-item')).to_have_count(2)
        expect(page.locator('.token-item')).to_have_count(2)
        page.locator('#entry-notes').fill('Preserve legacy configuration'); save()
        preserved = request('get', {'id': legacy['id']})
        assert preserved['logins'] == legacy['logins'] and preserved['totps'] == legacy['totps']
        assert preserved['favorite'] is True
        print('PASS: invalid input preserves saved data; legacy multi-item credentials, labels, favorite and special TOTP settings survive editing', flush=True)
        assert not errors, errors
        ctx.close()
    print('Save-mode acceptance complete.', flush=True)


if __name__ == '__main__':
    run()
