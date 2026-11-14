"""三种保存模式与本地二维码识别的真实扩展验收。"""
import base64
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
    images = fixtures()
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='credmemo-qr-') as profile:
        ctx = p.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True,
            args=['--no-sandbox', '--enable-unsafe-extension-debugging', f'--disable-extensions-except={ROOT / "dist"}', f'--load-extension={ROOT / "dist"}'],
            viewport={'width': 1280, 'height': 900}, device_scale_factor=2, locale='zh-CN')
        ctx.set_default_timeout(12000)
        errors, external = [], []
        ctx.on('page', lambda tab: tab.on('pageerror', lambda error: errors.append(str(error))))
        ctx.on('request', lambda request: external.append(request.url) if request.url.startswith(('http://', 'https://')) and not request.url.startswith('https://qr.example.test/') else None)
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
        base = worker.url.rsplit('/', 1)[0] + '/'
        page = ctx.new_page()
        page.goto(base + 'popup.html')
        master, password = str(uuid.uuid4())[:12], str(uuid.uuid4())
        expect(page.locator('#auth-screen')).to_be_visible()
        page.locator('#auth-password').fill(master)
        page.locator('#confirm-password').fill(master)
        page.locator('#auth-form button[type=submit]').click()
        expect(page.locator('#app-screen')).to_be_visible()

        def request(action, args=None, source=None):
            result = (source or page).evaluate('([action,args])=>chrome.runtime.sendMessage({type:"credmemo",action,args})', [action, args or {}])
            assert result['ok'], result.get('error')
            return result['data']

        expect(page.locator('.filter-tabs')).to_have_count(0)

        def create(title):
            page.locator('.heading-actions [data-action=new]').click()
            expect(page.locator('#entry-form input[type=radio]')).to_have_count(0)
            expect(page.locator('#entry-notes')).to_be_visible()
            expect(page.locator('#login-items .remove-item, #token-items .remove-item')).to_have_count(0)
            expect(page.locator('.token-item > .field-label')).to_have_text('2FA')
            assert page.locator('.modal-body').evaluate('node=>node.scrollHeight<=node.clientHeight')
            page.locator('#entry-title').fill(title)
            page.locator('#entry-options > summary').click()

        def login():
            page.locator('.login-item [data-field=username]').fill('fixture@example.test')
            page.locator('.login-item [data-field=password]').fill(password)

        def save():
            page.locator('button[form=entry-form]').click()
            expect(page.locator('#modal-root')).to_be_empty()

        create('仅账号密码')
        expect(page.locator('.token-item [data-field=secret]')).to_be_visible()
        page.locator('.login-options [data-action=generate]').click()
        assert len(page.locator('.login-item [data-field=password]').input_value()) == 24
        login(); save()
        create('手动密钥')
        expect(page.locator('.login-item [data-field=username]')).to_be_visible()
        page.locator('.token-item [data-field=secret]').fill(PUBLIC_SECRET)
        save()
        create('账号与对应2FA')
        login()
        page.locator('.token-item [data-field=secret]').fill(PUBLIC_SECRET)
        save()
        entries = request('list')['entries']
        shapes = {entry['title']: (len(entry['logins']), len(entry['totps'])) for entry in entries}
        assert shapes == {'仅账号密码': (1, 0), '手动密钥': (0, 1), '账号与对应2FA': (1, 1)}
        page.reload()
        expect(page.locator('.entry-card')).to_have_count(3)
        assert len(request('list')['entries']) == 3
        print('PASS: one form saves account-only, 2FA-only and combined entries without category or mode selection', flush=True)

        create('没有填写凭证')
        page.locator('button[form=entry-form]').click()
        expect(page.locator('#form-error')).to_contain_text('至少添加')
        login()
        page.locator('.token-item [data-field=secret]').fill('invalid 2FA fixture')
        page.locator('button[form=entry-form]').click()
        expect(page.locator('#form-error')).to_contain_text('2FA 密钥或参数无效')
        assert len(request('list')['entries']) == 3
        page.locator('#modal-root [data-action=close-modal]').first.click()
        combined = next(entry for entry in entries if entry['title'] == '账号与对应2FA')
        page.locator(f'[data-entry="{combined["id"]}"] [data-action=detail]').first.click()
        page.locator('#drawer-root [data-action=edit]').click()
        expect(page.locator('.login-item [data-field=password]')).to_have_value(password)
        expect(page.locator('.token-item [data-field=secret]')).to_have_value(PUBLIC_SECRET)
        page.locator('#entry-options > summary').click()
        page.locator('[data-action=add-login]').click()
        page.locator('[data-action=add-totp]').click()
        expect(page.locator('.primary-item .remove-item')).to_have_count(0)
        expect(page.locator('.remove-item')).to_have_count(2)
        page.locator('.login-item .remove-item').click()
        page.locator('.token-item .remove-item').click()
        expect(page.locator('.login-item')).to_have_count(1)
        expect(page.locator('.token-item')).to_have_count(1)
        page.locator('[data-action=add-login]').click()
        page.locator('[data-action=add-totp]').click()
        save()
        preserved = request('get', {'id': combined['id']})
        assert len(preserved['logins']) == len(preserved['totps']) == 1
        assert preserved['logins'][0]['password'] == password and preserved['totps'][0]['secret'] == PUBLIC_SECRET
        print('PASS: empty/invalid inputs preserve saved data; editing preserves both kinds and skips blank extra rows', flush=True)

        ctx.set_offline(True)
        create('')
        payload = {'name': 'qr-fixture.png', 'mimeType': 'image/png', 'buffer': base64.b64decode(images['valid'].split(',')[1])}
        page.locator('#qr-image').set_input_files(payload)
        expect(page.locator('#qr-status')).to_have_text('已识别 2FA，请检查后保存')
        expect(page.locator('.token-item')).to_have_count(1)
        expect(page.locator('.token-item.primary-item .remove-item')).to_have_count(0)
        expect(page.locator('#entry-title')).to_have_value('Example:fixture')
        expect(page.locator('.token-item [data-field=secret]')).to_have_value(PUBLIC_SECRET)
        assert page.locator('.token-item [data-field=secret]').get_attribute('type') == 'password'
        page.locator('.advanced-options summary').click()
        expect(page.locator('[data-field=digits]')).to_have_value('8')
        expect(page.locator('[data-field=period]')).to_have_value('60')
        expect(page.locator('[data-field=algorithm]')).to_have_value('SHA256')
        shots = ROOT / 'release' / 'screenshots'
        shots.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(shots / 'qr-image.png'))
        save()
        ctx.set_offline(False)
        expect(page.locator('.entry-card')).to_have_count(4)
        print('PASS: PNG QR recognized offline; label, secret, digits, period and algorithm survive save', flush=True)

        create('错误图片验收')
        for image, message in [('blank', '未找到二维码'), ('ordinary', '不是 2FA')]:
            page.locator('#qr-image').set_input_files({'name': image + '.png', 'mimeType': 'image/png', 'buffer': base64.b64decode(images[image].split(',')[1])})
            expect(page.locator('#form-error')).to_contain_text(message)
            expect(page.locator('.token-item [data-field=secret]')).to_have_value('')
        page.locator('#qr-image').set_input_files({'name': 'damaged.png', 'mimeType': 'image/png', 'buffer': b'damaged fixture'})
        expect(page.locator('#form-error')).to_contain_text('无法读取图片')
        assert len(request('list')['entries']) == 4
        page.locator('#modal-root [data-action=close-modal]').first.click()
        print('PASS: blank, unrelated and damaged QR images show errors without changing saved data', flush=True)

        # 暂缓实际图片解码，验证关闭表单后旧异步结果不会进入新表单。
        create('将关闭的表单')
        page.evaluate('''()=>{const original=window.createImageBitmap;window.createImageBitmap=async(...args)=>{await new Promise(resolve=>window.resumeQr=resolve);try{return await original(...args)}finally{window.createImageBitmap=original;window.qrResumed=true}}}''')
        page.locator('#qr-image').set_input_files(payload)
        expect(page.locator('#qr-status')).to_have_text('正在识别…')
        page.locator('#modal-root [data-action=close-modal]').first.click()
        create('新表单')
        page.evaluate('window.resumeQr()')
        page.wait_for_function('()=>window.qrResumed===true')
        expect(page.locator('.token-item [data-field=secret]')).to_have_value('')
        expect(page.locator('#entry-title')).to_have_value('新表单')
        page.locator('#modal-root [data-action=close-modal]').first.click()
        print('PASS: canceled image recognition cannot populate a later editor', flush=True)

        assert not external, external
        assert not errors, errors
        ctx.close()
    print('QR and save-mode acceptance complete.', flush=True)


if __name__ == '__main__':
    run()
