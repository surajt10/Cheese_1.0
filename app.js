/* Cheese1.0 renderer — purely a view. All state lives in the main process. Mouse-only UI. */
const $ = (id) => document.getElementById(id);
const api = window.cheese;

let state = null;
const imageCache = new Map(); // msgId -> dataURL
let lastRenderedConv = null;
let lastMessageSig = '';

marked.setOptions({ breaks: true, gfm: true });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prettyAccel = (a) => (a || '').replace('CommandOrControl', '⌘').replace('Command', '⌘').replace('Control', '⌃').replace('Shift', '⇧').replace('Alt', '⌥').replace('Option', '⌥').replace(/\+/g, '');
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ---------- rendering ----------
function render() {
  if (!state) return;
  renderTabs();
  renderMessages();
  renderStatus();
  renderBanners();
}

function renderTabs() {
  const el = $('tabs');
  el.innerHTML = state.conversations.map((c) => `
    <button class="tab ${c.id === state.activeId ? 'active' : ''}" data-id="${c.id}" title="${esc(c.title)}">
      ${c.pending ? '<span class="dot"></span>' : ''}
      <span class="t">${esc(c.title)}</span>
      <span class="x" data-del="${c.id}" title="Close">✕</span>
    </button>`).join('');
  const active = el.querySelector('.tab.active');
  if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function renderMessages() {
  const inner = $('messagesInner');
  const sig = state.activeId + '|' + state.messages.map((m) => `${m.id}:${m.pending}:${m.error}:${m.text.length}`).join(',');
  if (sig === lastMessageSig) return;
  const convChanged = lastRenderedConv !== state.activeId;
  lastMessageSig = sig; lastRenderedConv = state.activeId;

  if (!state.messages.length) {
    const s = state.session;
    inner.innerHTML = `
      <div class="empty"><div class="card">
        <h2>${s.running ? 'Ready.' : 'Welcome to Cheese'}</h2>
        ${s.running
          ? `<p>Press <kbd>${prettyAccel(state.hotkeys.capture)}</kbd> anywhere to screenshot <b>${esc(s.displayName)}</b> and get an answer here.<br>
             <kbd>${prettyAccel(state.hotkeys.captureNew)}</kbd> starts a fresh conversation. <kbd>${prettyAccel(state.hotkeys.toggleMode)}</kbd> toggles Auto mode.</p>`
          : `<p>You never type here. Cheese watches your screen and answers whatever it sees.</p>
             <ol>
               <li>Add an API key in <b>Settings</b> (⚙, top right).</li>
               <li>Click <b>Start screen share</b> and pick a screen.</li>
               <li>Open Mission Control and drag this window to a <b>new Desktop</b> so it lives off to the side.</li>
               <li>From anywhere, press <kbd>${prettyAccel(state.hotkeys.capture)}</kbd>. Answers appear in the active tab.</li>
             </ol>`}
      </div></div>`;
    return;
  }

  inner.innerHTML = state.messages.map((m) => {
    if (m.role === 'user') {
      return `<div class="msg user" data-id="${m.id}">
        <div class="avatar">🖥️</div>
        <div class="body">
          <div class="meta">Screenshot · ${fmtTime(m.at)} ${m.source === 'auto' ? '<span class="pill auto">auto</span>' : ''}</div>
          <img class="shot loading" data-img="${m.id}" alt="screenshot" />
        </div></div>`;
    }
    let body;
    if (m.pending) body = `<div class="thinking"><i></i><i></i><i></i></div>`;
    else if (m.error) body = `<div class="content">${esc(m.text)}</div>`;
    else body = `<div class="content">${marked.parse(m.text)}</div>`;
    return `<div class="msg assistant ${m.error ? 'error' : ''}" data-id="${m.id}">
      <div class="avatar">C</div>
      <div class="body"><div class="meta">${esc(state.model || 'assistant')} · ${fmtTime(m.at)}</div>${body}</div></div>`;
  }).join('');

  // lazy-load screenshots
  inner.querySelectorAll('img[data-img]').forEach(async (img) => {
    const id = img.dataset.img;
    let url = imageCache.get(id);
    if (!url) {
      url = await api.invoke('message:image', { convId: state.activeId, msgId: id });
      if (url) imageCache.set(id, url);
    }
    if (url) { img.src = url; img.classList.remove('loading'); }
  });

  // external links open in the browser
  inner.querySelectorAll('.content a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); api.invoke('open:external', a.href); }));

  const box = $('messages');
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  if (convChanged) box.scrollTop = box.scrollHeight;
}

function renderStatus() {
  const s = state.session;
  $('led').classList.toggle('on', s.running);
  $('statusText').textContent = s.running
    ? `Sharing ${s.displayName} · ${state.provider} / ${state.model}${s.busy ? ' · thinking…' : ''}`
    : 'Not sharing — click Start screen share';
  $('modeManual').classList.toggle('active', s.mode === 'manual');
  $('modeAuto').classList.toggle('active', s.mode === 'auto');
  $('modeAuto').classList.toggle('auto', s.mode === 'auto');
  $('countdown').textContent = (s.running && s.mode === 'auto' && s.nextFireAt && !s.busy)
    ? `next auto shot in ${Math.max(0, s.nextFireAt - s.idleSeconds)}s idle`
    : '';
  $('kbdCapture').textContent = prettyAccel(state.hotkeys.capture);
  $('btnCapture').disabled = s.busy;
  const start = $('btnStart');
  start.textContent = s.running ? 'Stop sharing' : 'Start screen share';
  start.classList.toggle('primary', !s.running);
  start.classList.toggle('danger', s.running);
}

function renderBanners() {
  const s = state.session;
  $('permBanner').hidden = !(s.screenPermission === 'denied' || s.screenPermission === 'restricted');
  $('keyBanner').hidden = state.hasKey;
  $('hotkeyBanner').hidden = s.hotkeysOk;
  $('hotkeyBannerText').textContent = s.hotkeysOk ? '' : `Hotkey problem: ${s.hotkeyError}`;
}

// ---------- toasts ----------
function showToast({ text, kind }) {
  const el = document.createElement('div');
  el.className = `toast ${kind || ''}`; el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

// ---------- screen picker ----------
async function openPicker() {
  const list = await api.invoke('sources:list');
  $('sources').innerHTML = list.map((src) => `
    <button class="source" data-display="${esc(src.displayId)}" data-name="${esc(src.name)}">
      ${src.thumbnail ? `<img src="${src.thumbnail}" alt="" />` : '<div class="shot loading"></div>'}
      <div class="n">${esc(src.name)}${src.primary ? ' (main)' : ''} <span>${esc(src.size)}</span></div>
    </button>`).join('') || '<p class="sub">No screens found. Check Screen Recording permission.</p>';
  $('picker').hidden = false;
}

// ---------- events ----------
$('tabs').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { api.invoke('conv:delete', del.dataset.del); e.stopPropagation(); return; }
  const tab = e.target.closest('.tab');
  if (tab) api.invoke('conv:select', tab.dataset.id);
});
$('btnNewTab').onclick = () => api.invoke('conv:new');
$('btnSettings').onclick = () => api.invoke('settings:open');
$('btnKeySettings').onclick = () => api.invoke('settings:open');
$('btnHotkeySettings').onclick = () => api.invoke('settings:open');
$('btnPrivacy').onclick = () => api.invoke('open:privacy');
$('btnCapture').onclick = () => api.invoke('capture', {});
$('modeSwitch').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) api.invoke('mode:set', b.dataset.mode); });
$('btnStart').onclick = () => { if (state?.session.running) api.invoke('session:stop'); else openPicker(); };
$('btnPickerCancel').onclick = () => { $('picker').hidden = true; };
$('sources').addEventListener('click', (e) => {
  const b = e.target.closest('.source'); if (!b) return;
  $('picker').hidden = true;
  api.invoke('session:start', { displayId: b.dataset.display, name: b.dataset.name });
});
$('messagesInner').addEventListener('click', (e) => {
  const img = e.target.closest('img.shot'); if (!img || !img.src) return;
  $('lightboxImg').src = img.src; $('lightbox').hidden = false;
});
$('lightbox').onclick = () => { $('lightbox').hidden = true; };

api.on('state', (s) => { state = s; render(); });
api.on('toast', showToast);
api.invoke('state:get').then((s) => { state = s; render(); });
