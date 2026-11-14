import { I18N } from './i18n.js';
import { normalizeTotp } from './totp.ts';
(() => {
  'use strict';
  const {t} = I18N;
  let target = null;
  let initialized = false;
  let lastTouch = 0;
  const $ = (selector, root=document) => root.querySelector(selector);
  const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon = name => `<svg aria-hidden="true"><use href="/static/icons.svg#${name}"/></svg>`;
  const iconButton = (name, action, label, attrs='', className='') => `<button type="button" class="icon-button ${className}" data-action="${action}" aria-label="${escape(t(label))}" title="${escape(t(label))}" ${attrs}>${icon(name)}</button>`;
  const state = {unlocked:false,entries:[],codes:{},offset:0,filter:'all',authMode:'login',generation:0,lastActive:Date.now(),codePending:false,codeRetryAt:0,codeError:false};
  let theme = localStorage.getItem('credmemo-theme') || 'system';
  let selected = null;
  let modalOpener = null;
  let transferFile = null;
  function applyTheme() {
    const resolved = theme==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):theme;
    document.documentElement.dataset.theme = resolved;
    $('meta[name="theme-color"]').content = resolved==='dark'?'#141917':'#f7f8fa';
    $$('[data-action="theme"] use').forEach(el=>el.setAttribute('href',`/static/icons.svg#${resolved==='dark'?'moon':'sun'}`));
  }
  function toast(message, error=false) {
    const node=document.createElement('div');node.className=`toast${error?' error':''}`;
    node.innerHTML=icon(error?'info':'check')+`<span>${escape(message)}</span>`;
    $('#toast-root').replaceChildren(node);setTimeout(()=>node.remove(),4500);
  }
  async function request(action, args={}) {
    const generation = state.generation;
    let response;
    try {response=await chrome.runtime.sendMessage({type:'credmemo',action,args});}
    catch {throw new Error(t('local_error'));}
    if(generation!==state.generation&&!['lock','changePassword'].includes(action))throw new DOMException('Vault changed','AbortError');
    if(!response?.ok){
      const code=response?.error||'local_error';
      if(code==='unauthorized')showAuth();
      const error=new Error(t(code));error.code=code;throw error;
    }
    return response.data;
  }
  function showAuth() {
    state.generation++;state.unlocked=false;state.entries=[];state.codes={};state.codePending=false;state.codeRetryAt=0;state.codeError=false;selected=null;transferFile=null;
    closeModal();closeDrawer();$('#entries').replaceChildren();$('#auth-password').value='';$('#confirm-password').value='';
    state.filter='all';$('#search').value='';render();
    $('#app-screen').hidden=true;$('#auth-screen').hidden=false;$('#loading-screen').hidden=true;
    authMode(initialized?'unlock':'setup');
  }
  function authMode(mode) {
    state.authMode=mode;
    const setup=mode==='setup';
    if(!state.unlocked)document.documentElement.dataset.view=setup?'setup':'unlock';
    $('#auth-title').textContent=t(setup?'setupTitle':'welcome');
    $('#auth-subtitle').textContent=t(setup?'setupDescription':'unlockDescription');
    $('#auth-submit-label').textContent=t(setup?'setupButton':'unlock');
    $('#confirm-field').hidden=!setup;$('#confirm-password').required=setup;
    $('#auth-password').autocomplete=setup?'new-password':'current-password';
    $('#auth-password').minLength=6;$('#auth-password').maxLength=setup?12:256;
    $('#auth-password').placeholder=t(setup?'newPasswordPlaceholder':'passwordPlaceholder');
    $('#auth-error').hidden=true;
  }
  async function showApp() {
    initialized=true;state.unlocked=true;state.lastActive=Date.now();document.documentElement.dataset.view='vault';$('#auth-screen').hidden=true;$('#app-screen').hidden=false;$('#loading-screen').hidden=true;
    $('#auth-password').value='';$('#confirm-password').value='';
    target=await request('target');
    const scanned=await request('qr-result');
    if(scanned&&!scanned.editor){state.filter='all';$('#search').value='';toast(t('qrSaved'));}
    await loadEntries();
    if(scanned?.editor){await editEntry(scanned.editor.id,scanned.editor);toast(t(scanned.outcome==='recognized'?'qrRecognized':'qrCancelled'));}
  }
  function matchesSite(entry){try{return !!target&&new URL(entry.url).origin===target.origin;}catch{return false;}}
  async function loadEntries() {
    try {
      const data=await request('list');if(!state.unlocked)return;state.entries=data.entries;render();await refreshCodes();
    } catch(error) {
      if(error.name==='AbortError'||!state.unlocked)return;
      $('#entries').innerHTML=`<div class="connection-error">${escape(error.message)}<br><button class="button secondary" data-action="reload">${escape(t('retry'))}</button></div>`;
    }
  }
  function domain(url) { try {return new URL(url).hostname.replace(/^www\./,'');} catch{return '';} }
  function entryIcon(entry) {const color=[...entry.title].reduce((sum,ch)=>sum+ch.codePointAt(0),0)%5;return `<span class="service-icon color-${color}">${escape(entry.title.slice(0,1).toUpperCase())}</span>`;}
  function tokenBlock(id,index=0) {
    return `<div class="totp-block" data-token="${id}:${index}"><div class="totp-header"><span>${icon('shield')}${escape(t('totpLabel'))}</span><span class="token-period"></span></div><div class="totp-body"><span class="totp-code">••• •••</span>${iconButton('copy','copy-code','copyCode',`data-id="${id}" data-index="${index}"`)}<div class="countdown"><svg viewBox="0 0 28 28"><circle class="track" cx="14" cy="14" r="12"/><circle class="progress" cx="14" cy="14" r="12"/></svg><span>—</span></div></div></div>`;
  }
  function renderCard(entry) {
    const id=entry.id,first=entry.logins[0];
    const login=first?`<div class="entry-account">${icon('user')}<span title="${escape(first.username)}">${escape(first.username)}</span>${iconButton('copy','copy-username','copyUsername',`data-id="${id}"`)}</div><div class="entry-password">${icon('lock')}<span>••••••••••</span>${iconButton('eye','reveal-card','showPassword',`data-id="${id}"`)}${iconButton('copy','copy-password','copyPassword',`data-id="${id}" data-index="0"`)}</div>`:'';
    const footer=[entry.logins.length>1?`<span class="tag-count">${escape(t('accountCount',{n:entry.logins.length}))}</span>`:'',entry.totps.length>1?`<span class="tag-count">${escape(t('moreTokens',{n:entry.totps.length-1}))} 2FA</span>`:'',matchesSite(entry)&&entry.logins.length?`<button class="text-button fill-button" data-action="fill" data-id="${id}">${escape(t('fill'))}</button>`:''].join('');
    return `<article class="entry-card" data-entry="${id}"><div class="entry-card-top"><button class="entry-card-top" data-action="detail" data-id="${id}" aria-label="${escape(t('viewDetails'))}" style="padding:0;text-align:left;flex:1;min-width:0">${entryIcon(entry)}<div class="entry-title"><h3>${escape(entry.title)}</h3>${entry.url?`<small>${escape(domain(entry.url))}</small>`:''}</div></button><span class="card-actions">${iconButton('edit','edit','editCredential',`data-id="${id}"`)}${iconButton('trash','delete','deleteCredential',`data-id="${id}"`,'delete-button')}<button class="icon-button favorite-button ${entry.favorite?'is-favorite':''}" data-action="favorite" data-id="${id}" aria-label="${escape(t(entry.favorite?'unfavorite':'favorite'))}" title="${escape(t(entry.favorite?'unfavorite':'favorite'))}">${icon('star')}</button></span></div>${login}${entry.totps.length?tokenBlock(id):''}${footer?`<div class="entry-card-footer">${footer}</div>`:''}</article>`;
  }
  function render() {
    const entries=state.entries;
    const favorite=$('[data-action="filter"][data-filter="favorite"]');
    favorite.classList.toggle('is-favorite',state.filter==='favorite');favorite.setAttribute('aria-pressed',String(state.filter==='favorite'));
    const query=$('#search').value.trim().toLowerCase();
    const filtered=entries.filter(entry=>(state.filter!=='favorite'||entry.favorite)&&(!query||[entry.title,entry.url,...entry.logins.map(l=>l.username),...entry.totps.map(l=>l.label)].some(value=>value.toLowerCase().includes(query))));
    filtered.sort((a,b)=>b.updated_at-a.updated_at);
    $('#page-title').textContent=t(state.filter==='favorite'?'favorites':'allCredentials');
    $('#results-count').textContent=t('itemCount',{n:filtered.length});
    $('#entries').innerHTML=filtered.map(renderCard).join('');
    $('#empty-state').hidden=!!filtered.length;
    if(!filtered.length){const empty=entries.length===0;$('#empty-state').innerHTML=`<div class="empty-icon">${icon(empty?'layers':'search')}</div><h2>${escape(t(empty?'emptyTitle':'emptySearchTitle'))}</h2><p>${escape(t(empty?'emptyDescription':'emptySearchDescription'))}</p><button class="button ${empty?'primary':'secondary'}" data-action="${empty?'new':'clear'}">${icon(empty?'plus':'refresh')}${escape(t(empty?'addCredential':'clearFilters'))}</button>`;}
    tickCodes();codeStatus();
  }
  function codeStatus() {
    const label=$('.results-line [data-i18n="codesRefresh"]');
    label.textContent=t(state.codeError?'connectionFailed':'codesRefresh');
    label.style.color=state.codeError?'var(--red)':'';
  }
  async function refreshCodes() {
    if(!state.unlocked||state.codePending)return;
    state.codePending=true;
    try {const data=await request('codes');state.offset=data.now*1000-Date.now();state.codes=data.codes;state.codeRetryAt=0;state.codeError=false;tickCodes();codeStatus();}
    catch(error){if(error.name!=='AbortError'&&state.unlocked){state.codes={};state.codeRetryAt=Date.now()+5000;state.codeError=true;tickCodes();codeStatus();}}
    finally{state.codePending=false;}
  }
  function tickCodes() {
    const now=(Date.now()+state.offset)/1000;
    $$('[data-token]').forEach(node=>{
      const [id,index]=node.dataset.token.split(':'),token=state.codes[id]?.[index];
      const left=token?Math.max(0,Math.ceil(token.expires_at-now)):0;
      $('.totp-code',node).textContent=left?token.code.slice(0,token.code.length/2)+' '+token.code.slice(token.code.length/2):'••• •••';
      $('.countdown>span',node).textContent=left||'—';
      $('.progress',node).style.strokeDashoffset=75.4*(1-(token?left/token.period:0));
      $('.token-period',node).textContent=token?`${token.period}s`:'';
      $('[data-action="copy-code"]',node).disabled=!left;
    });
  }
  async function copy(value) {
    try {if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);toast(t('copied'));return;}} catch{}
    const area=document.createElement('textarea');area.value=value;area.style.cssText='position:fixed;top:0;left:-9999px';document.body.append(area);area.select();
    const success=document.execCommand('copy');area.remove();
    if(success){toast(t('copied'));return;}
    openModal(t('copyManually'),`<p class="confirm-text">${escape(t('clipboardBlocked'))}</p><textarea class="input copy-fallback" id="copy-fallback" readonly></textarea>`, '', 'small');$('#copy-fallback').value=value;$('#copy-fallback').select();
  }
  function openModal(title,body,footer='',size='') {
    modalOpener=document.activeElement;$('#modal-root').innerHTML=`<div class="modal-overlay"><section class="modal ${size}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><h2 id="modal-title">${escape(title)}</h2>${iconButton('close','close-modal','close')}</header><div class="modal-body">${body}</div>${footer?`<footer class="modal-footer">${footer}</footer>`:''}</section></div>`;
    document.body.style.overflow='hidden';setTimeout(()=>{
      const input=$$('#modal-root input:not([type="hidden"]):not([type="radio"]), #modal-root select, #modal-root textarea').find(node=>!node.disabled&&node.getClientRects().length);
      (input||$('#modal-root button'))?.focus();
    },20);
  }
  function closeModal() {$('#modal-root').replaceChildren();transferFile=null;if(!$('#drawer-root').children.length)document.body.style.overflow='';if(modalOpener?.isConnected)modalOpener.focus();modalOpener=null;}
  function closeDrawer() {$('#drawer-root').replaceChildren();selected=null;if(!$('#modal-root').children.length)document.body.style.overflow='';}
  const field=(label,name,value='',placeholder='',type='text',extra='')=>`<label class="field-label" for="${name}">${escape(t(label))}</label><input class="input" id="${name}" name="${name}" type="${type}" value="${escape(value)}" placeholder="${escape(t(placeholder))}" ${extra}>`;
  let itemSequence=0;
  function loginFields(item={},primary=false) {
    const n=++itemSequence;
    return `<div class="form-item login-item${primary?' primary-item':''}">${primary?'':iconButton('close','remove-item','removeItem','','remove-item')}
      <label class="field-label" for="login-user-${n}">${escape(t('account'))}</label><input class="input" id="login-user-${n}" data-field="username" value="${escape(item.username||'')}" placeholder="${escape(t('accountPlaceholder'))}" maxlength="320" autocomplete="off">
      <label class="field-label" for="login-password-${n}">${escape(t('password'))}</label><div class="input-wrap"><input id="login-password-${n}" data-field="password" type="password" value="${escape(item.password||'')}" maxlength="1000" autocomplete="new-password" placeholder="${escape(t('passwordValuePlaceholder'))}">${iconButton('eye','toggle-password','showPassword',`data-target="login-password-${n}"`)}</div>
      <input type="hidden" data-field="label" value="${escape(item.label||'')}"></div>`;
  }
  function totpFields(item={},primary=false) {
    const n=++itemSequence,custom=(item.digits??6)!==6||(item.period??30)!==30||(item.algorithm??'SHA1')!=='SHA1';
    return `<div class="form-item token-item${primary?' primary-item':''}">${primary?'':iconButton('close','remove-item','removeItem','','remove-item')}<label class="field-label" for="token-secret-${n}">${escape(t('totpSecret'))}</label><div class="input-wrap"><input id="token-secret-${n}" data-field="secret" type="password" value="${escape(item.secret||'')}" maxlength="4096" autocomplete="off" placeholder="${escape(t('totpSecretPlaceholder'))}">${iconButton('scan','scan-entry','scanSelection')}${iconButton('eye','toggle-password','showPassword',`data-target="token-secret-${n}"`)}</div>
      <input type="hidden" data-field="label" value="${escape(item.label||'')}"><details class="advanced-options" ${custom?'':'hidden'}><summary>${escape(t('advanced'))}</summary><div class="token-options">${[['digits',[6,8]],['period',[15,30,60]],['algorithm',['SHA1','SHA256','SHA512']]].map(([name,options])=>`<label for="token-${name}-${n}">${escape(t(name))}<select class="select" id="token-${name}-${n}" data-field="${name}">${options.map(value=>`<option value="${value}" ${String(item[name]??(name==='digits'?6:name==='period'?30:'SHA1'))===String(value)?'selected':''}>${value}${name==='period'?'s':''}</option>`).join('')}</select></label>`).join('')}</div></details></div>`;
  }
  async function editEntry(id,draft=null) {
    const entry=draft?{...draft.entry,version:draft.version}:id?await request('get',{id}):null;
    closeDrawer();
    const body=`<form id="entry-form" data-id="${id||''}" data-version="${entry?.version||''}" data-favorite="${!!entry?.favorite}">
      ${field('title','entry-title',entry?.title,'titlePlaceholder','text','required maxlength="150"')}
      ${field('website','entry-url',entry?.url,'websitePlaceholder','text','maxlength="2000"')}
      <section><div id="login-items">${(entry?.logins.length?entry.logins:[{}]).map((item,index)=>loginFields(item,index===0)).join('')}</div></section>
      <section><div id="token-items">${(entry?.totps.length?entry.totps:[{}]).map((item,index)=>totpFields(item,index===0)).join('')}</div></section>
      <label class="field-label" for="entry-notes">${escape(t('notes'))}</label><textarea id="entry-notes" class="input" rows="2" maxlength="10000" placeholder="${escape(t('notesPlaceholder'))}">${escape(entry?.notes||'')}</textarea>
      <div id="form-error" class="inline-error" role="alert" hidden></div></form>`;
    openModal(t(id?'editCredential':'addCredential'),body,`<button class="button secondary" data-action="close-modal">${escape(t('cancel'))}</button><button type="submit" form="entry-form" class="button primary">${escape(t('save'))}</button>`,'editor');
    $('#entry-title').focus();
  }
  function editorValues(form) {
    const readItems=selector=>$$(selector,form).map(node=>Object.fromEntries($$('[data-field]',node).map(input=>[input.dataset.field,['digits','period'].includes(input.dataset.field)?Number(input.value):input.value])));
    return {title:$('#entry-title').value,url:$('#entry-url').value,notes:$('#entry-notes').value,favorite:form.dataset.favorite==='true',logins:readItems('.login-item'),totps:readItems('.token-item')};
  }
  async function saveEntry(form) {
    const data=editorValues(form);
    data.title=data.title.trim();data.url=data.url.trim();data.logins=data.logins.filter(item=>item.username.trim()||item.password||item.label.trim());data.totps=data.totps.filter(item=>item.secret.trim()||item.label.trim());
    if(!data.logins.length&&!data.totps.length)throw new Error(t('credential_required'));
    const id=form.dataset.id;
    await request('save',{id:id||undefined,entry:data,version:id?Number(form.dataset.version):undefined});
    if(!id){state.filter='all';$('#search').value='';}
    closeModal();toast(t('saved'));await loadEntries();
  }
  async function detail(id) {
    const entry=await request('get',{id});selected=entry;
    const date=value=>new Date(value*1000).toLocaleDateString(I18N.language==='zh'?'zh-CN':'en-US');
    $('#drawer-root').innerHTML=`<div class="drawer-overlay"><section class="drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title"><header class="drawer-header">${entryIcon(entry)}<div><h2 id="detail-title">${escape(entry.title)}</h2><small>${escape(t('personalVault'))}</small></div>${iconButton('close','close-drawer','close')}</header><div class="drawer-body">${entry.url?`<h3 class="detail-heading">${icon('globe')}${escape(t('website'))}</h3><a class="detail-url" href="${escape(entry.url)}" target="_blank" rel="noopener noreferrer">${escape(entry.url)}${icon('external')}</a>`:''}${entry.logins.length?`<h3 class="detail-heading">${icon('key')}${escape(t('loginGroups'))}</h3>`:''}${entry.logins.map((login,index)=>`<section class="detail-group">${login.label?`<h3>${escape(login.label)}</h3>`:''}<span class="detail-label">${escape(t('account'))}</span><div class="detail-row"><div class="detail-value">${escape(login.username)||'—'}</div>${iconButton('copy','copy-username','copyUsername',`data-id="${id}" data-index="${index}"`)}</div><span class="detail-label">${escape(t('password'))}</span><div class="detail-row"><div class="detail-value"><input type="password" readonly id="detail-password-${index}" aria-label="${escape(t('password'))}"></div>${iconButton('eye','toggle-password','showPassword',`data-target="detail-password-${index}"`)}${iconButton('copy','copy-password','copyPassword',`data-id="${id}" data-index="${index}"`)}</div></section>`).join('')}${entry.totps.length?`<h3 class="detail-heading">${icon('timer')}${escape(t('twoFactor'))}</h3>`:''}${entry.totps.map((token,index)=>`<section class="detail-group">${token.label?`<h3>${escape(token.label)}</h3>`:''}${tokenBlock(id,index)}</section>`).join('')}${entry.notes?`<h3 class="detail-heading">${icon('list')}${escape(t('notes'))}</h3><div class="detail-notes">${escape(entry.notes)}</div>`:''}<div class="detail-meta"><span>${escape(t('created'))} ${date(entry.created_at)}</span><span>${escape(t('updated'))} ${date(entry.updated_at)}</span></div></div><footer class="drawer-footer"><button class="button danger" data-action="delete" data-id="${id}">${icon('trash')}${escape(t('delete'))}</button><button class="button secondary" data-action="favorite" data-id="${id}">${icon('star')}${escape(t(entry.favorite?'unfavorite':'favorite'))}</button><button class="button primary" data-action="edit" data-id="${id}">${icon('edit')}${escape(t('edit'))}</button></footer></section></div>`;
    entry.logins.forEach((login,index)=>$(`#detail-password-${index}`).value=login.password);tickCodes();document.body.style.overflow='hidden';$('#drawer-root [data-action="close-drawer"]').focus();
  }
  function transfer(tab='backup') {
    transferFile=null;
    const tabs=`<div class="transfer-tabs">${['backup','import','export'].map(name=>`<button class="${tab===name?'active':''}" data-action="transfer-tab" data-tab="${name}">${escape(t(name))}</button>`).join('')}</div>`;
    let body='';
    if(tab==='backup') body=`<div class="notice">${icon('shield')}<span>${escape(t('backupHint'))}</span></div><form id="backup-form">${field('backupPassword','backup-password','','backupPasswordPlaceholder','password','required minlength="12" maxlength="256" autocomplete="new-password"')}${field('confirmBackup','backup-confirm','','confirmBackup','password','required minlength="12" maxlength="256" autocomplete="new-password"')}<div class="inline-error" id="transfer-error" hidden role="alert"></div><button type="submit" class="button primary" style="margin-top:14px">${icon('download')}${escape(t('downloadBackup'))}</button></form>`;
    if(tab==='export') body=`<div class="notice warning">${icon('info')}<span>${escape(t('exportWarning'))}</span></div><form id="export-form">${field('confirmMaster','export-password','','passwordPlaceholder','password','required minlength="6" maxlength="256" autocomplete="current-password"')}<div class="inline-error" id="transfer-error" hidden role="alert"></div><div style="display:flex;gap:9px;margin-top:14px;flex-wrap:wrap"><button type="submit" class="button primary" name="mode" value="download">${icon('download')}${escape(t('downloadJson'))}</button><button type="submit" class="button secondary" name="mode" value="copy">${icon('copy')}${escape(t('copyJson'))}</button></div></form>`;
    if(tab==='import') body=`<form id="import-form"><label class="upload-zone">${icon('upload')}<b id="file-name">${escape(t('selectFile'))}</b><span>${escape(t('fileTypes'))}</span><input id="import-file" type="file" accept=".json,.credmemo,application/json" aria-label="${escape(t('selectFile'))}" required></label><div id="restore-password-field" hidden>${field('restorePassword','restore-password','','restorePasswordPlaceholder','password','minlength="12" maxlength="256" autocomplete="off"')}</div><div class="notice">${icon('info')}<span>${escape(t('importHint'))}</span></div><div class="inline-error" id="transfer-error" hidden role="alert"></div><button type="submit" class="button primary">${icon('upload')}${escape(t('importButton'))}</button></form>`;
    openModal(t('dataCenter'),tabs+`<section class="transfer-panel">${body}</section>`,'','transfer');
  }
  function download(data,filename) {const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function transferSubmit(form,event) {
    const stamp=new Date().toISOString().slice(0,10);
    if(form.id==='backup-form') {
      if($('#backup-password').value!==$('#backup-confirm').value)throw new Error(t('backupMismatch'));
      const data=await request('backup',{password:$('#backup-password').value});download(data,`CredMemo-${stamp}.credmemo`);closeModal();toast(t('backupDownloaded'));
    } else if(form.id==='export-form') {
      const data=await request('export',{password:$('#export-password').value});
      const mode=event.submitter?.value;closeModal();if(mode==='copy')await copy(JSON.stringify(data,null,2));else{download(data,`CredMemo-${stamp}.json`);toast(t('exported'));}
    } else {
      if(!transferFile)throw new Error(t('file_required'));
      let result;
      if(transferFile.format==='credmemo-backup')result=await request('restore',{password:$('#restore-password').value,backup:transferFile});
      else result=await request('import',{entries:transferFile.entries});
      closeModal();toast(t('imported',{n:result.imported}));await loadEntries();
    }
  }
  function settings() {
    openModal(t('settings'),`<div class="settings-row"><b>${escape(t('appearance'))}</b><select class="select" id="theme-select" aria-label="${escape(t('theme'))}">${['light','dark','system'].map(value=>`<option value="${value}" ${theme===value?'selected':''}>${escape(t(value))}</option>`).join('')}</select></div><div class="settings-row"><b>${escape(t('language'))}</b><select class="select" id="language-select" aria-label="${escape(t('language'))}"><option value="zh" ${I18N.language==='zh'?'selected':''}>简体中文</option><option value="en" ${I18N.language==='en'?'selected':''}>English</option></select></div><div class="settings-row"><b>${escape(t('masterPassword'))}</b><button class="text-button" data-action="change-password">${escape(t('changePassword'))}</button></div><p class="session-hint">${icon('lock')}${escape(t('sessionDescription'))}</p>`,`<button class="button secondary" data-action="lock">${icon('lock')}${escape(t('lockNow'))}</button>`,'preferences');
  }
  function setLanguage(value) {I18N.set(value);authMode(state.authMode);if(state.unlocked)render();applyTheme();}
  async function lockVault() {try{await request('lock');}catch{}finally{showAuth();}}
  async function action(button) {
    const {action,id,index='0'}=button.dataset;
    if(action==='scan-page'||action==='scan-entry'){
      const form=action==='scan-entry'?$('#entry-form'):null;
      const editor=form?{id:form.dataset.id,version:Number(form.dataset.version||0),entry:editorValues(form),tokenIndex:$$('.token-item',form).indexOf(button.closest('.token-item'))}:undefined;
      button.disabled=true;
      try{
        const {id:windowId}=await chrome.windows.getCurrent();
        await request('qr-start',{windowId,editor,labels:{hint:t('pageScanHint'),cancel:t('cancel'),small:t('qr_selection_small'),scanning:t('qrScanning'),saved:t(editor?'qrRecognized':'qrSaved'),failed:t('qr_capture_failed'),errors:Object.fromEntries(['qr_not_found','qr_not_totp','invalid_totp','totp_only','qr_page_changed','unauthorized','forbidden','too_large'].map(code=>[code,t(code)]))}});window.close();
      }finally{if(button.isConnected)button.disabled=false;}
      return;
    }
    if(action==='fill'){
      const entry=state.entries.find(item=>item.id===id);
      if(!entry||!target)throw new Error(t('fill_failed'));
      if(entry.logins.length>1&&button.dataset.index===undefined){
        openModal(t('chooseLogin'),entry.logins.map((login,index)=>`<button class="login-choice" data-action="fill" data-id="${id}" data-index="${index}">${icon('user')}<span>${escape(login.label||login.username)}</span>${icon('arrow-right')}</button>`).join(''),'','small');return;
      }
      const result=await request('fill',{id,index:Number(button.dataset.index||0),tabId:target.id});
      closeModal();toast(t(result.usernameOnly?'fillUserOnly':'fillDone'));return;
    }
    if(action==='language'){setLanguage(I18N.language==='zh'?'en':'zh');return;}
    if(action==='theme'){theme=document.documentElement.dataset.theme==='dark'?'light':'dark';localStorage.setItem('credmemo-theme',theme);applyTheme();toast(t(theme));return;}
    if(action==='toggle-password'){const input=document.getElementById(button.dataset.target);input.type=input.type==='password'?'text':'password';$('use',button).setAttribute('href',`/static/icons.svg#${input.type==='password'?'eye':'eye-off'}`);return;}
    if(action==='filter'){state.filter=state.filter==='favorite'?'all':'favorite';render();return;}
    if(action==='clear'){state.filter='all';$('#search').value='';render();return;}
    if(action==='new'||action==='edit')return editEntry(id);
    if(action==='detail')return detail(id);
    if(action==='close-modal')return closeModal();
    if(action==='close-drawer')return closeDrawer();
    if(action==='lock')return lockVault();
    if(action==='reload')return loadEntries();
    if(action==='remove-item'){const item=button.closest('.form-item');if(!item.classList.contains('primary-item'))item.remove();return;}
    if(action==='copy-code'){const token=state.codes[id]?.[Number(index)];if(!token||token.expires_at*1000<=Date.now()+state.offset){await refreshCodes();return;}return copy(token.code);}
    if(action==='copy-username')return copy(state.entries.find(e=>e.id===id)?.logins[Number(index)]?.username||'');
    if(action==='copy-password'){const entry=selected?.id===id?selected:await request('get',{id});return copy(entry.logins[Number(index)].password);}
    if(action==='reveal-card'){const value=$('.entry-password>span',button.closest('.entry-card'));if(value.dataset.visible){value.textContent='••••••••••';delete value.dataset.visible;return;}const data=await request('get',{id});value.textContent=data.logins[0].password;value.style.cssText='letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%;font-size:11px';value.dataset.visible='true';setTimeout(()=>{if(value.isConnected){value.textContent='••••••••••';delete value.dataset.visible;}},15000);return;}
    if(action==='favorite'){const entry=await request('get',{id});const {id:entryId,created_at,updated_at,...data}=entry;data.favorite=!data.favorite;await request('save',{id,entry:data,version:entry.version});await loadEntries();if(selected?.id===id)await detail(id);return;}
    if(action==='delete'){const entry=state.entries.find(e=>e.id===id);openModal(t('deleteCredential'),`<p class="confirm-text">${escape(t('deleteConfirm',{title:entry.title}))}</p>`,`<button class="button secondary" data-action="close-modal">${escape(t('cancel'))}</button><button class="button danger" data-action="confirm-delete" data-id="${id}" data-version="${entry.version}">${escape(t('delete'))}</button>`,'small');return;}
    if(action==='confirm-delete'){await request('delete',{id,version:Number(button.dataset.version)});closeModal();closeDrawer();toast(t('deleted'));return loadEntries();}
    if(action==='transfer')return transfer();
    if(action==='transfer-tab')return transfer(button.dataset.tab);
    if(action==='settings')return settings();
    if(action==='change-password')return openModal(t('changePassword'),`<div class="notice">${icon('info')}<span>${escape(t('changePasswordHint'))}</span></div><form id="password-form">${field('currentPassword','current-password','','passwordPlaceholder','password','required minlength="6" maxlength="256" autocomplete="current-password"')}${field('newPassword','new-password','','newPasswordPlaceholder','password','required minlength="6" maxlength="12" autocomplete="new-password"')}${field('confirmPassword','new-password-confirm','','repeatPassword','password','required minlength="6" maxlength="12" autocomplete="new-password"')}<div id="form-error" class="inline-error" hidden role="alert"></div></form>`,`<button class="button secondary" data-action="close-modal">${escape(t('cancel'))}</button><button type="submit" class="button primary" form="password-form">${escape(t('changePassword'))}</button>`,'small');
  }
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
    try{await action(button);}catch(error){if(error.name!=='AbortError')toast(error.message||t('connectionFailed'),true);}
  });
  document.addEventListener('submit',async event=>{
    const form=event.target;event.preventDefault();const submit=event.submitter;
    const errorNode=form.id==='auth-form'?$('#auth-error'):$('#form-error')||$('#transfer-error');
    if(errorNode)errorNode.hidden=true;if(submit)submit.disabled=true;
    try {
      if(form.id==='auth-form'){
        if(state.authMode==='setup'&&$('#auth-password').value!==$('#confirm-password').value)throw new Error(t('password_mismatch'));
        await request(state.authMode==='setup'?'initialize':'unlock',{password:$('#auth-password').value});await showApp();
      }else if(form.id==='entry-form')await saveEntry(form);
      else if(form.id==='password-form'){
        if($('#new-password').value!==$('#new-password-confirm').value)throw new Error(t('password_mismatch'));
        await request('changePassword',{current_password:$('#current-password').value,new_password:$('#new-password').value});showAuth();toast(t('passwordChanged'));
      }else await transferSubmit(form,event);
    }catch(error){if(error.name==='AbortError')return;if(errorNode?.isConnected){errorNode.textContent=error.message||t('connectionFailed');errorNode.hidden=false;}else toast(error.message||t('connectionFailed'),true);}
    finally{if(submit?.isConnected)submit.disabled=false;}
  });
  document.addEventListener('change',async event=>{
    const input=event.target;
    if(input.matches('.token-item [data-field=secret]')&&/^otpauth:\/\//i.test(input.value.trim())){
      // 配置链接优先使用自身参数，无效内容留给保存时的校验处理。
      try {
        const item=input.closest('.token-item'),token=normalizeTotp({secret:input.value,label:$('[data-field=label]',item).value});
        $$('[data-field]',item).forEach(field=>field.value=token[field.dataset.field]);
        $('.advanced-options',item).hidden=token.digits===6&&token.period===30&&token.algorithm==='SHA1';
      }catch{}
      return;
    }
    if(input.id==='theme-select'){theme=input.value;localStorage.setItem('credmemo-theme',theme);applyTheme();return;}
    if(input.id==='language-select'){setLanguage(input.value);settings();return;}
    if(input.id==='import-file'){
      const file=input.files[0];transferFile=null;$('#transfer-error').hidden=true;$('#restore-password-field').hidden=true;$('#restore-password').required=false;
      if(!file)return;
      try{if(file.size>10*1024*1024)throw new Error(t('too_large'));const data=JSON.parse(await file.text());if(!data||!((data.format==='credmemo-backup'&&data.version===2)||(data.format==='credmemo-export'&&data.version===1))||data.format==='credmemo-export'&&!Array.isArray(data.entries))throw new Error(t('import_invalid'));transferFile=data;$('#file-name').textContent=file.name;$('#restore-password-field').hidden=data.format!=='credmemo-backup';$('#restore-password').required=data.format==='credmemo-backup';}
      catch(error){$('#transfer-error').textContent=error instanceof SyntaxError?t('import_invalid'):error.message;$('#transfer-error').hidden=false;input.value='';}
    }
  });
  $('#search').addEventListener('input',render);
  ['pointerdown','keydown','touchstart'].forEach(name=>document.addEventListener(name,()=>state.lastActive=Date.now(),{passive:true}));
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'){if($('#modal-root').children.length)closeModal();else closeDrawer();}
    if(event.key==='/'&&state.unlocked&&!['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)){event.preventDefault();$('#search').focus();}
    if(event.key==='Tab'){
      const root=$('#modal-root .modal')||$('#drawer-root .drawer');if(!root)return;
      const focusable=$$('button:not(:disabled),input:not(:disabled),select,textarea,a[href],summary',root).filter(el=>el.offsetParent!==null);
      const first=focusable[0],last=focusable.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.unlocked){if(Date.now()-state.lastActive>=15*60*1000)lockVault();else refreshCodes();}});
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyTheme);
  setInterval(()=>{
    if(!state.unlocked)return;
    if(Date.now()-state.lastActive>=15*60*1000){lockVault();return;}
    if(state.lastActive>lastTouch&&Date.now()-lastTouch>=15000){lastTouch=Date.now();void request('touch').catch(()=>{});}
    tickCodes();
    if((state.codeRetryAt&&Date.now()>=state.codeRetryAt)||Object.values(state.codes).flat().some(token=>token.expires_at*1000<=Date.now()+state.offset))refreshCodes();
  },1000);
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  I18N.apply();applyTheme();
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='session'&&changes['credmemo-session']&&!changes['credmemo-session'].newValue&&state.unlocked)showAuth();
    if(area==='local'&&changes['credmemo-vault']&&state.unlocked)void loadEntries();
  });
  request('status').then(status=>{initialized=status.initialized;return status.unlocked?showApp():showAuth();}).catch(error=>{showAuth();$('#auth-error').textContent=error.message;$('#auth-error').hidden=false;});
})();
