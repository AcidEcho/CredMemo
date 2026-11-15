"""当前网页直接框选二维码验收，使用真实工具栏和两倍像素截图。"""
import base64
import json
import re
import tempfile
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from fill_acceptance import Popup
from qr_acceptance import CHROME, PUBLIC_SECRET, fixtures

ROOT = Path(__file__).resolve().parents[2]


def run():
    images = fixtures()
    html = f'''<!doctype html><html><head><meta charset="utf-8"><title>CredMemo QR fixture</title></head>
    <body style="margin:0;font:16px system-ui;background:#f7f8fa;height:1800px">
    <main style="margin:100px auto;width:660px;padding:32px;background:white;border-radius:16px">
    <h1>CredMemo · 网页二维码测试</h1><p>公开 RFC 测试数据</p>
    <img id="qr" width="360" height="360" src="{images['valid']}" alt="公开测试二维码"></main></body></html>'''
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='credmemo-page-scan-') as profile:
        ctx = p.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True,
            args=['--no-sandbox', '--enable-unsafe-extension-debugging', '--screen-info={1280x900}', f'--disable-extensions-except={ROOT/"dist"}', f'--load-extension={ROOT/"dist"}'],
            viewport={'width':1280,'height':900}, device_scale_factor=2, locale='zh-CN')
        ctx.set_default_timeout(12000)
        errors=[]
        ctx.on('page',lambda page:page.on('pageerror',lambda error:errors.append(str(error))))
        worker=ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
        base=worker.url.rsplit('/',1)[0]+'/'
        client=ctx.new_page();client.goto(base+'popup.html')
        master=str(uuid.uuid4())[:12]
        expect(client.locator('#auth-screen')).to_be_visible()
        client.locator('#auth-password').fill(master);client.locator('#confirm-password').fill(master)
        client.locator('#auth-form button[type=submit]').click()
        expect(client.locator('#app-screen')).to_be_visible()

        def request(action,args=None):
            response=client.evaluate('([action,args])=>chrome.runtime.sendMessage({type:"credmemo",action,args})',[action,args or {}])
            assert response['ok'],response.get('error')
            return response['data']

        site=ctx.new_page()
        site.route('https://qr.example.test/**',lambda route:route.fulfill(body=html,content_type='text/html'))
        site.goto('https://qr.example.test/setup');expect(site.locator('#qr')).to_be_visible()
        cdp=ctx.browser.new_browser_cdp_session()
        source_target=ctx.new_cdp_session(client).send('Target.getTargetInfo')['targetInfo']['targetId']

        def popup(trigger=True):
            if trigger:
                site.bring_to_front()
                tab=next(item for item in cdp.send('Target.getTargets',{'filter':[{}]})['targetInfos'] if item['type']=='tab' and item['url']==site.url)
                cdp.send('Extensions.triggerAction',{'id':base.split('/')[2],'targetId':tab['targetId']})
            for _ in range(100):
                target=next((item for item in cdp.send('Target.getTargets')['targetInfos'] if item['url']==base+'popup.html' and item['targetId']!=source_target),None)
                if target:break
                client.wait_for_timeout(30)
            assert target,'Toolbar popup did not open'
            view=Popup(cdp,client,target['targetId'])
            view.wait('document.querySelector("#app-screen")?.hidden===false')
            return view

        before_windows=client.evaluate('chrome.windows.getAll().then(windows=>windows.length)')
        before_tabs=client.evaluate('chrome.tabs.query({}).then(tabs=>tabs.length)')

        def start():
            view=popup();view.evaluate('document.querySelector("[data-action=scan-page]").click()')
            expect(site.locator('#credmemo-qr-selection')).to_have_attribute('data-state','selecting')
            assert client.evaluate('chrome.windows.getAll().then(windows=>windows.length)')==before_windows
            assert client.evaluate('chrome.tabs.query({}).then(tabs=>tabs.length)')==before_tabs
            return site.locator('#credmemo-qr-selection')

        def drag(x,y,width,height,preview=False):
            site.mouse.move(x+width,y+height);site.mouse.down();site.mouse.move(x,y,steps=8)
            if preview:site.screenshot(path=str(shots/'page-selection.png'))
            site.mouse.up()

        overlay=start()
        denied=client.evaluate('chrome.runtime.sendMessage({type:"credmemo-qr-selection",action:"select",nonce:"fake"})')
        assert denied=={'ok':False,'error':'forbidden'}
        assert site.evaluate('typeof chrome.runtime?.sendMessage')=='undefined'
        site.locator('#credmemo-qr-selection').dispatch_event('pointerup',{'clientX':400,'clientY':400})
        assert request('list')['entries']==[]
        drag(20,120,3,3)
        expect(overlay).to_have_attribute('aria-label',re.compile('请框选完整二维码'))
        drag(20,120,30,30)
        expect(overlay).to_have_attribute('aria-label',re.compile('未找到二维码'))
        assert request('list')['entries']==[]
        site.keyboard.press('Escape');expect(overlay).to_have_count(0)
        client.wait_for_function('async()=>!(await chrome.storage.session.get("credmemo-qr-scan"))["credmemo-qr-scan"]')
        print('PASS: toolbar scan enters the current page directly without new windows, tabs or desktop capture permission',flush=True)
        print('PASS: forged sender/events, small/blank regions and Esc cancellation preserve the vault',flush=True)

        client.wait_for_timeout(600)
        overlay=start()
        rect=site.locator('#qr').bounding_box();assert rect
        shots=ROOT/'release/screenshots';shots.mkdir(parents=True,exist_ok=True)
        drag(rect['x'],rect['y'],rect['width'],rect['height'],preview=True)
        saved=None
        for _ in range(150):
            saved=next((entry for entry in request('list')['entries'] if entry['title']=='Example:fixture'),None)
            if saved:break
            client.wait_for_timeout(50)
        if not saved:raise AssertionError(overlay.get_attribute('aria-label'))
        entry=request('get',{'id':saved['id']})
        assert entry['url']=='https://qr.example.test' and entry['logins']==[]
        assert entry['totps'][0]=={'label':'Example:fixture','secret':PUBLIC_SECRET,'digits':8,'period':60,'algorithm':'SHA256'}
        for _ in range(100):
            target=next((item for item in cdp.send('Target.getTargets')['targetInfos'] if item['url']==base+'popup.html' and item['targetId']!=source_target),None)
            if target:break
            client.wait_for_timeout(50)
        assert target
        view=Popup(cdp,client,target['targetId'])
        view.wait('document.querySelector("[data-action=copy-code]")?.disabled===false&&!document.querySelector(".filter-tabs")')
        assert view.evaluate('innerWidth===360&&document.querySelector(".main-content").scrollWidth===document.querySelector(".main-content").clientWidth')
        (shots/'page-result.png').write_bytes(base64.b64decode(view.send('Page.captureScreenshot',{'format':'png'})['data']))
        assert PUBLIC_SECRET not in json.dumps(client.evaluate('chrome.storage.local.get(null)'))
        print('PASS: reversed selection at 2x scale auto-saves encrypted TOTP and returns to the unified list',flush=True)

        view.evaluate('document.querySelector(".heading-actions [data-action=new]").click()')
        view.wait('!!document.querySelector("#entry-form")')
        password=str(uuid.uuid4())
        fields={'#entry-title':'扫码回填测试','#entry-url':'https://qr.example.test/login',
            '.login-item [data-field=username]':'fixture@example.test',
            '.login-item [data-field=password]':password,'#entry-notes':'未保存的备注'}

        def values(view):
            return view.evaluate('Object.fromEntries('+json.dumps(list(fields))+'.map(selector=>[selector,document.querySelector(selector).value]))')

        view.evaluate('Object.entries('+json.dumps(fields)+').forEach(([selector,value])=>document.querySelector(selector).value=value)')
        view.evaluate('document.querySelector("[data-action=scan-entry]").click()')
        expect(site.locator('#credmemo-qr-selection')).to_have_attribute('data-state','selecting')
        # 草稿跨后台休眠仍可恢复，且不进入网页或持久存储。
        worker_target=next(item for item in cdp.send('Target.getTargets')['targetInfos'] if item['type']=='service_worker' and item['url']==base+'background.js')
        cdp.send('Target.closeTarget',{'targetId':worker_target['targetId']})
        assert password not in site.content()
        assert password not in json.dumps(client.evaluate('chrome.storage.local.get(null)'))
        drag(20,120,30,30)
        expect(site.locator('#credmemo-qr-selection')).to_have_attribute('aria-label',re.compile('未找到二维码'))
        assert len(request('list')['entries'])==1
        site.keyboard.press('Escape')
        view=popup(trigger=False);view.wait('!!document.querySelector("#entry-form")')
        assert values(view)==fields
        assert view.evaluate('document.querySelector(".token-item [data-field=secret]").value')==''
        assert len(request('list')['entries'])==1
        print('PASS: editor scan survives worker restart; blank regions and cancellation restore all unsaved fields without saving',flush=True)

        view.evaluate('document.querySelector("[data-action=scan-entry]").click()')
        expect(site.locator('#credmemo-qr-selection')).to_have_attribute('data-state','selecting')
        client.wait_for_timeout(600)
        drag(rect['x'],rect['y'],rect['width'],rect['height'])
        view=popup(trigger=False);view.wait('!!document.querySelector("#entry-form")')
        assert values(view)==fields
        assert view.evaluate('document.querySelector(".token-item [data-field=secret]").value')==PUBLIC_SECRET
        assert view.evaluate('Object.fromEntries([...document.querySelectorAll(".token-item [data-field]")].filter(node=>["type","digits","period","algorithm"].includes(node.dataset.field)).map(node=>[node.dataset.field,node.value]))')=={'type':'totp','digits':'8','period':'60','algorithm':'SHA256'}
        assert len(request('list')['entries'])==1
        view.evaluate('document.querySelector("button[form=entry-form]").click()')
        view.wait('!document.querySelector("#entry-form")')
        created=next(entry for entry in request('list')['entries'] if entry['title']==fields['#entry-title'])
        saved_draft=request('get',{'id':created['id']})
        assert saved_draft['logins'][0]['password']==password
        assert saved_draft['totps'][0]['secret']==PUBLIC_SECRET and saved_draft['notes']==fields['#entry-notes']
        view.evaluate('document.querySelector(\'[data-entry="'+created['id']+'"] [data-action=edit]\').click()')
        view.wait('!!document.querySelector("#entry-form")')
        view.evaluate('document.querySelector("[data-action=scan-entry]").click()')
        expect(site.locator('#credmemo-qr-selection')).to_have_attribute('data-state','selecting')
        client.wait_for_timeout(600)
        drag(rect['x'],rect['y'],rect['width'],rect['height'])
        view=popup(trigger=False);view.wait('!!document.querySelector("#entry-form")')
        assert values(view)==fields
        view.evaluate('document.querySelector("button[form=entry-form]").click()')
        view.wait('!document.querySelector("#entry-form")')
        assert len(request('list')['entries'])==2
        assert request('get',{'id':created['id']})['version']==saved_draft['version']+1
        assert password not in json.dumps(client.evaluate('chrome.storage.local.get(null)'))
        print('PASS: recognized QR fills the original form and parameters; only Save creates or updates the original credential',flush=True)

        view.evaluate('document.querySelector(".heading-actions [data-action=new]").click()')
        view.wait('!!document.querySelector("#entry-form")')
        view.evaluate('document.querySelector("[data-action=scan-entry]").click()')
        expect(site.locator('#credmemo-qr-selection')).to_have_attribute('data-state','selecting')
        request('lock');expect(site.locator('#credmemo-qr-selection')).to_have_count(0)
        client.wait_for_function('async()=>{const data=await chrome.storage.session.get(null);return !data["credmemo-qr-result"]&&!data["credmemo-qr-scan"]}')
        assert client.evaluate('chrome.runtime.sendMessage({type:"credmemo",action:"qr-result",args:{}})')=={'ok':False,'error':'unauthorized'}
        request('unlock',{'password':master})
        print('PASS: locking clears the editor draft and blocks QR result access',flush=True)

        overlay=start();request('lock');expect(overlay).to_have_count(0)
        request('unlock',{'password':master})
        overlay=start();site.goto('https://qr.example.test/changed');expect(overlay).to_have_count(0)
        assert len(request('list')['entries'])==2
        site.goto('chrome://version')
        view=popup();view.evaluate('document.querySelector("[data-action=scan-page]").click()')
        view.wait('document.querySelector("#toast-root").textContent.includes("普通网页")')
        view.evaluate('document.querySelector(".heading-actions [data-action=new]").click()')
        view.wait('!!document.querySelector("#entry-form")')
        view.evaluate('document.querySelector("#entry-title").value="Protected page draft";document.querySelector("[data-action=scan-entry]").click()')
        view.wait('document.querySelector("#toast-root").textContent.includes("普通网页")')
        assert view.evaluate('document.querySelector("#entry-title").value')=='Protected page draft'
        assert not client.evaluate('chrome.storage.session.get("credmemo-qr-result").then(data=>data["credmemo-qr-result"])')
        assert client.evaluate('chrome.tabs.query({}).then(tabs=>tabs.length)')==before_tabs
        assert 'desktopCapture' not in client.evaluate('chrome.runtime.getManifest().permissions')
        assert client.evaluate('typeof chrome.action.setUserSettings')=='undefined'
        assert not errors,errors
        print('PASS: locking and navigation remove selection; browser-internal pages show a clear error; pinning has no extension setter',flush=True)
        ctx.close()


if __name__=='__main__':
    run()
