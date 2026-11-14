import { I18N } from './i18n.js';
import { captureDesktopFrame } from './qr-capture.ts';
import { installQrSelection } from './qr-selection.ts';
import { imageRegion, readQrImage } from './qr.ts';

const {t} = I18N;
const canvas = document.querySelector('#capture');
const status = document.querySelector('#screen-status');
const captureButton = document.querySelector('#capture-again');
const empty = document.querySelector('#empty-preview');
let controller = null;
let saving = false;
let generation = 0;

I18N.apply();
document.title = `CredMemo · ${t('screenScanTitle')}`;
canvas.setAttribute('aria-label',t('screenSelectionLabel'));
const theme = localStorage.getItem('credmemo-theme') || 'system';
document.documentElement.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;

function show(message, state) {
  status.textContent = message;
  status.classList.toggle('error',state === 'error');
  document.body.dataset.state = state;
}
async function request(action, token) {
  const response = await chrome.runtime.sendMessage({type:'credmemo-scan',action,token});
  if(!response?.ok)throw new Error(response?.error || 'local_error');
  return response.data;
}
function clearImage() {
  canvas.width = 1; canvas.height = 1; canvas.hidden = true; resetSelection(); empty.hidden = false;
}
async function capture() {
  if(saving)return;
  const current = ++generation;
  controller?.abort(); controller = new AbortController();
  clearImage(); captureButton.disabled = true; show(t('screenChoosing'),'choosing');
  try {
    const vault = await request('status');
    if(!vault.unlocked)throw new Error('unauthorized');
    const snapshot = await captureDesktopFrame(controller.signal);
    if(current !== generation)return;
    canvas.width = snapshot.width; canvas.height = snapshot.height;
    canvas.getContext('2d').drawImage(snapshot,0,0);
    snapshot.width = snapshot.height = 1;
    empty.hidden = true; canvas.hidden = false;
    show(t('screenReady'),'selecting');
  } catch(error) {
    if(current !== generation || error.name === 'AbortError')return;
    const code = error.message === 'screen_capture_cancelled' ? 'screen_capture_cancelled' : ['unauthorized','forbidden','too_large'].includes(error.message) ? error.message : 'screen_capture_failed';
    show(t(code),code === 'screen_capture_cancelled' ? 'cancelled' : 'error');
  } finally {if(current === generation)captureButton.disabled = false;}
}
async function selected(region) {
  if(saving)return;
  if(region.width < 12 || region.height < 12){show(t('screenTooSmall'),'error');return;}
  const current = generation;
  saving = true; canvas.setAttribute('aria-busy','true'); captureButton.disabled = true;
  show(t('qrScanning'),'recognizing');
  try {
    const crop = imageRegion(region,canvas.width,canvas.height);
    const selected = new OffscreenCanvas(crop.width,crop.height);
    selected.getContext('2d').drawImage(canvas,crop.x,crop.y,crop.width,crop.height,0,0,crop.width,crop.height);
    const token = await readQrImage(await selected.convertToBlob({type:'image/png'}));
    selected.width = selected.height = 1;
    if(current !== generation)return;
    await request('save',token);
    if(current !== generation)return;
    clearImage(); show(t('qrSaved'),'saved');
  } catch(error) {
    if(current !== generation)return;
    show(t(error.code || error.message || 'local_error'),'error');
  } finally {
    saving = false; canvas.setAttribute('aria-busy','false');
    if(current === generation)captureButton.disabled = document.body.dataset.state === 'saved';
  }
}
const resetSelection = installQrSelection(canvas,document.querySelector('#selection'),region=>void selected(region));
captureButton.addEventListener('click',()=>void capture());
document.querySelector('#close-scan').addEventListener('click',()=>window.close());
document.addEventListener('keydown',event=>{if(event.key === 'Escape' && !saving && !canvas.hidden){resetSelection();show(t('screenReady'),'selecting');}});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area === 'session' && changes['credmemo-session'] && !changes['credmemo-session'].newValue){
    generation++; controller?.abort(); clearImage(); captureButton.disabled = true; show(t('unauthorized'),'error');
  }
});
window.addEventListener('pagehide',()=>{generation++;controller?.abort();clearImage();});
void capture();
