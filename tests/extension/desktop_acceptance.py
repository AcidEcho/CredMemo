"""系统屏幕捕获验收：二维码绘制于独立的原生窗口中，捕获使用真实 Chrome API。"""
import base64
import argparse
import json
import subprocess
import tempfile
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from fill_acceptance import Popup
from native_qr_fixture import NativeQrWindow

ROOT = Path(__file__).resolve().parents[2]
CHROME = '/root/python/.playwright-browsers/chromium-1234/chrome-linux64/chrome'
SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
URI = f'otpauth://totp/Desktop%3Afixture?secret={SECRET}&digits=8&period=60&algorithm=SHA256'


def run(source='screen'):
    matrix = json.loads(subprocess.check_output(['node','-e','const m=require("qrcode").create(process.argv[1]).modules;process.stdout.write(JSON.stringify({size:m.size,data:Array.from(m.data)}))',URI],cwd=ROOT))
    native = NativeQrWindow(matrix)
    try:
        with tempfile.TemporaryDirectory(prefix='credmemo-desktop-') as profile,sync_playwright() as p:
            source_name = 'Entire screen' if source == 'screen' else 'CredMemo External QR'
            ctx = p.chromium.launch_persistent_context(profile,executable_path=CHROME,headless=False,
                args=['--no-sandbox','--enable-unsafe-extension-debugging','--window-position=0,0',f'--disable-extensions-except={ROOT/"dist"}',f'--load-extension={ROOT/"dist"}',f'--auto-select-desktop-capture-source={source_name}'],viewport={'width':1280,'height':900})
            ctx.set_default_timeout(15000)
            errors = []
            ctx.on('page',lambda page:page.on('pageerror',lambda error:errors.append(str(error))))
            ctx.add_init_script('''(()=>{if(!navigator.mediaDevices)return;const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async options=>{window.captureOptions=options;const stream=await original(options);window.captureTracks=stream.getTracks();window.captureSettings=stream.getVideoTracks()[0].getSettings();return stream;};})();''')
            worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
            base = worker.url.rsplit('/',1)[0]+'/'
            client = ctx.new_page();client.goto(base+'popup.html')
            master = str(uuid.uuid4())
            expect(client.locator('#auth-screen')).to_be_visible()
            client.locator('#auth-password').fill(master);client.locator('#confirm-password').fill(master);client.locator('#auth-form button[type=submit]').click()
            expect(client.locator('#app-screen')).to_be_visible()
            def request(action,args=None):
                result=client.evaluate('([action,args])=>chrome.runtime.sendMessage({type:"credmemo",action,args})',[action,args or {}]);assert result['ok'],result.get('error');return result['data']
            # 使用浏览器内部页面发起扫描，确认不再依赖网页访问权限。
            site=ctx.new_page();site.goto('chrome://version');site.bring_to_front()
            cdp=ctx.browser.new_browser_cdp_session();source_target=ctx.new_cdp_session(client).send('Target.getTargetInfo')['targetInfo']['targetId']
            tab=next(item for item in cdp.send('Target.getTargets',{'filter':[{}]})['targetInfos'] if item['type']=='tab' and item['url']==site.url)
            cdp.send('Extensions.triggerAction',{'id':base.split('/')[2],'targetId':tab['targetId']})
            target=None
            for _ in range(50):
                target=next((item for item in cdp.send('Target.getTargets')['targetInfos'] if item['url']==base+'popup.html' and item['targetId']!=source_target),None)
                if target:break
                client.wait_for_timeout(50)
            assert target
            popup=Popup(cdp,client,target['targetId']);popup.wait('document.querySelector("#app-screen")?.hidden===false')
            with ctx.expect_page() as opened:
                popup.evaluate('document.querySelector("[data-action=scan-page]").click()')
            scanner=opened.value;scanner.wait_for_url(base+'scan.html')
            expect(scanner.locator('body')).to_have_attribute('data-state','selecting')
            assert scanner.evaluate('window.captureOptions.audio') is False
            assert scanner.evaluate('window.captureTracks.every(track=>track.readyState==="ended")')
            assert scanner.evaluate('window.captureSettings.displaySurface') == ('monitor' if source == 'screen' else 'window'),scanner.evaluate('window.captureSettings')
            print(f'PASS: scan from browser internal page captures {source} and stops every media track before selection',flush=True)
            denied=client.evaluate('chrome.runtime.sendMessage({type:"credmemo-scan",action:"save",token:{secret:"'+SECRET+'"}})')
            assert denied == {'ok':False,'error':'forbidden'}
            assert request('list')['entries']==[]

            def drag(left,top,width,height,preview=False):
                scanner.mouse.move(left+width,top+height);scanner.mouse.down();scanner.mouse.move(left,top,steps=8)
                if preview:
                    scanner.screenshot(path=str(shots/f'{source}-selection.png'))
                scanner.mouse.up()

            rect=scanner.locator('#capture').bounding_box();assert rect
            drag(rect['x']+2,rect['y']+2,3,3)
            expect(scanner.locator('#screen-status')).to_contain_text('请框选完整二维码')
            drag(rect['x']+2,rect['y']+2,16,16)
            expect(scanner.locator('#screen-status')).to_contain_text('未找到二维码')
            assert request('list')['entries']==[]
            # 仅模拟来源选择器的取消回调，验证取消后可通过真实捕获重试。
            scanner.evaluate('()=>{window.originalChooser=chrome.desktopCapture.chooseDesktopMedia;chrome.desktopCapture.chooseDesktopMedia=(sources,callback)=>{setTimeout(()=>callback(""),0);return 1}}')
            scanner.locator('#capture-again').click()
            expect(scanner.locator('body')).to_have_attribute('data-state','cancelled')
            expect(scanner.locator('#capture')).to_be_hidden()
            assert scanner.locator('#capture').evaluate('canvas=>canvas.width===1&&canvas.height===1')
            scanner.keyboard.press('Escape')
            expect(scanner.locator('body')).to_have_attribute('data-state','cancelled')
            scanner.evaluate('()=>{chrome.desktopCapture.chooseDesktopMedia=window.originalChooser}')
            scanner.locator('#capture-again').click()
            expect(scanner.locator('body')).to_have_attribute('data-state','selecting')
            assert scanner.evaluate('window.captureTracks.every(track=>track.readyState==="ended")')
            print('PASS: small/blank selections preserve data; cancelled capture clears snapshot and can retry',flush=True)

            rect=scanner.locator('#capture').bounding_box();assert rect
            intrinsic=scanner.locator('#capture').evaluate('canvas=>({width:canvas.width,height:canvas.height})')
            image_width,image_height = (1920,1080) if source == 'screen' else (native.bounds['width']+16,native.bounds['height']+56)
            assert intrinsic == {'width':image_width,'height':image_height},intrinsic
            left,top = (native.bounds['x'],native.bounds['y']) if source == 'screen' else (8,40)
            x=rect['x']+left*rect['width']/image_width
            y=rect['y']+top*rect['height']/image_height
            width=native.bounds['width']*rect['width']/image_width
            height=native.bounds['height']*rect['height']/image_height
            shots=ROOT/'release/screenshots';shots.mkdir(exist_ok=True,parents=True)
            drag(x,y,width,height,preview=True)
            saved=None
            for _ in range(150):
                saved=next((entry for entry in request('list')['entries'] if entry['title']=='Desktop:fixture'),None)
                if saved:break
                client.wait_for_timeout(50)
            if not saved:
                raise AssertionError(scanner.locator('#screen-status').inner_text())
            actual=request('get',{'id':saved['id']})
            assert actual['url']=='' and actual['logins']==[] and actual['totps'][0]['secret']==SECRET
            assert actual['totps'][0]['digits']==8 and actual['totps'][0]['period']==60 and actual['totps'][0]['algorithm']=='SHA256'
            for _ in range(100):
                target=next((item for item in cdp.send('Target.getTargets')['targetInfos'] if item['url']==base+'popup.html' and item['targetId']!=source_target),None)
                if target:break
                client.wait_for_timeout(50)
            assert target
            popup=Popup(cdp,client,target['targetId'])
            popup.wait('document.querySelector(".filter-tabs .active")?.dataset.type==="totp"&&!document.querySelector("[data-action=copy-code]")?.disabled')
            (shots/f'{source}-result.png').write_bytes(base64.b64decode(popup.send('Page.captureScreenshot',{'format':'png'})['data']))
            assert len(request('list')['entries'])==1
            assert SECRET not in json.dumps(client.evaluate('chrome.storage.local.get(null)'))
            print('PASS: QR outside Chrome auto-saves encrypted 2FA and returns to the two-factor popup; untrusted sender cannot save',flush=True)
            scanner.wait_for_event('close') if not scanner.is_closed() else None
            with ctx.expect_page() as reopened:
                request('qr-start')
            scanner=reopened.value
            expect(scanner.locator('body')).to_have_attribute('data-state','selecting')
            assert request('qr-start')['selecting']
            assert len([page for page in ctx.pages if page.url==base+'scan.html'])==1
            request('lock')
            expect(scanner.locator('#capture')).to_be_hidden()
            expect(scanner.locator('#capture-again')).to_be_disabled()
            expect(scanner.locator('#screen-status')).to_contain_text('解锁')
            assert scanner.locator('#capture').evaluate('canvas=>canvas.width===1&&canvas.height===1')
            denied=scanner.evaluate('chrome.runtime.sendMessage({type:"credmemo-scan",action:"save",token:{secret:"'+SECRET+'"}})')
            assert not denied['ok']
            scanner.locator('#close-scan').click()
            request('unlock',{'password':master})
            with ctx.expect_page() as reopened:
                request('qr-start')
            scanner=reopened.value
            expect(scanner.locator('body')).to_have_attribute('data-state','selecting')
            scanner.locator('#close-scan').click()
            client.wait_for_function('async()=>!(await chrome.storage.session.get("credmemo-qr-scan"))["credmemo-qr-scan"]')
            assert len(request('list')['entries'])==1
            assert not errors,errors
            print('PASS: scanner is reused; locking clears snapshot and blocks saving; closing clears session for a new scan',flush=True)
            ctx.close()
    finally:
        native.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',choices=['screen','window'],default='screen')
    run(parser.parse_args().source)
