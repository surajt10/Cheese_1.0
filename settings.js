const $ = (id) => document.getElementById(id);
const api = window.cheese;

const TEXT = ['provider', 'openaiKey', 'openaiModel', 'openaiBaseUrl', 'geminiKey', 'geminiModel', 'anthropicKey', 'anthropicModel',
  'systemPrompt', 'hotkeyCapture', 'hotkeyCaptureNew', 'hotkeyToggleMode', 'defaultMode'];
const NUM = ['maxHistoryImages', 'autoIdleSeconds'];
const BOOL = ['autoRepeat', 'autoSkipUnchanged', 'hideDockWhenRunning', 'notifyOnAnswer', 'alwaysOnTop', 'showOnAllDesktops'];

function showProvider() {
  document.querySelectorAll('.prov').forEach((el) => el.classList.remove('show'));
  $('prov-' + $('provider').value).classList.add('show');
}

async function load() {
  const s = await api.invoke('settings:get');
  TEXT.forEach((k) => { $(k).value = s[k] ?? ''; });
  NUM.forEach((k) => { $(k).value = s[k] ?? ''; });
  BOOL.forEach((k) => { $(k).checked = !!s[k]; });
  $('systemPrompt').placeholder = s.defaultSystemPrompt;
  $('promptHint').textContent = 'Default: ' + s.defaultSystemPrompt.split('\n')[0] + ' …';
  showProvider();
}

function collect() {
  const out = {};
  TEXT.forEach((k) => { out[k] = $(k).value.trim(); });
  NUM.forEach((k) => { out[k] = Number($(k).value) || 0; });
  BOOL.forEach((k) => { out[k] = $(k).checked; });
  if (out.autoIdleSeconds < 5) out.autoIdleSeconds = 45;
  if (out.maxHistoryImages < 1) out.maxHistoryImages = 4;
  return out;
}

// ---- hotkey recorder → Electron accelerator strings ----
const KEYMAP = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', '+': 'Plus' };
function accelFromEvent(e) {
  const mods = [];
  if (e.metaKey || e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let key = e.key;
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return null;
  if (KEYMAP[key]) key = KEYMAP[key];
  else if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
  else if (/^F\d{1,2}$/.test(key) || /^\d$/.test(key)) { /* fine */ }
  else if (e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3); // handles Option-modified chars on mac
  else if (e.code && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (key.length !== 1) return null;
  if (!mods.length && !/^F\d{1,2}$/.test(key)) return null; // require a modifier for non-F keys
  return [...mods, key].join('+');
}
document.querySelectorAll('.hk input').forEach((inp) => {
  inp.addEventListener('focus', () => { inp.classList.add('rec'); inp.dataset.prev = inp.value; inp.value = 'Press keys…'; });
  inp.addEventListener('blur', () => { inp.classList.remove('rec'); if (inp.value === 'Press keys…') inp.value = inp.dataset.prev || ''; });
  inp.addEventListener('keydown', (e) => {
    e.preventDefault();
    const a = accelFromEvent(e);
    if (a) { inp.value = a; inp.blur(); }
  });
});
document.querySelectorAll('[data-clear]').forEach((b) => { b.onclick = () => { $(b.dataset.clear).value = ''; }; });
document.querySelectorAll('a[data-url]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); api.invoke('open:external', a.dataset.url); }; });

$('provider').onchange = showProvider;
$('btnSave').onclick = async () => { await api.invoke('settings:save', collect()); api.invoke('settings:close'); };
$('btnCancel').onclick = () => api.invoke('settings:close');
load();
