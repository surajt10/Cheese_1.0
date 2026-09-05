// Cheese1.0 — main process.
// Owns: windows, global hotkeys, screen capture, auto mode (idle timer), conversations, AI calls.
const {
  app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen, powerMonitor,
  Notification, shell, systemPreferences, Menu,
} = require('electron');
const path = require('path');
const crypto = require('crypto');
const Store = require('./store');
const { askModel, DEFAULT_SYSTEM_PROMPT } = require('./providers');
const { captureDisplay, toJpegBase64, fingerprint, fingerprintDiff } = require('./capture');

const IS_MAC = process.platform === 'darwin';

const DEFAULT_SETTINGS = {
  provider: 'openai',
  openaiKey: '', openaiModel: 'gpt-4o', openaiBaseUrl: '',
  geminiKey: '', geminiModel: 'gemini-2.5-flash',
  anthropicKey: '', anthropicModel: 'claude-sonnet-4-5',
  systemPrompt: '',
  hotkeyCapture: 'CommandOrControl+Shift+1',
  hotkeyCaptureNew: 'CommandOrControl+Shift+2',
  hotkeyToggleMode: 'CommandOrControl+Shift+3',
  defaultMode: 'manual',           // 'manual' | 'auto'
  autoIdleSeconds: 45,             // auto mode: screenshot after this many idle seconds
  autoRepeat: true,                // keep taking one every autoIdleSeconds while still idle
  autoSkipUnchanged: true,         // don't resend a screen that hasn't changed
  maxHistoryImages: 4,
  hideDockWhenRunning: true,
  notifyOnAnswer: true,
  showOnAllDesktops: false,
  alwaysOnTop: false,
};

let settingsStore, convStore;
let mainWin = null;
let settingsWin = null;

// In-memory session state (not persisted)
const session = {
  running: false,
  displayId: null,
  displayName: '',
  mode: 'manual',
  busy: false,
  idleSeconds: 0,
  nextFireAt: Infinity,
  lastFingerprint: null,
  autoTimer: null,
  hotkeysOk: true,
  hotkeyError: '',
  screenPermission: 'unknown',
};

// ---------- helpers ----------
const S = () => settingsStore.get();
const uid = () => crypto.randomBytes(6).toString('hex');

function conversations() { return convStore.get('conversations'); }
function activeConv() {
  const list = conversations();
  return list.find((c) => c.id === convStore.get('activeId')) || list[0] || null;
}
function newConversation(select = true) {
  const list = conversations();
  const conv = { id: uid(), title: `Chat ${list.length + 1}`, createdAt: Date.now(), messages: [] };
  list.unshift(conv);
  if (select) convStore.set({ conversations: list, activeId: conv.id });
  else convStore.set({ conversations: list });
  return conv;
}
function touch() { convStore.save(); broadcastState(); }

function publicState() {
  const list = conversations().map((c) => ({
    id: c.id, title: c.title, createdAt: c.createdAt, count: c.messages.length,
    pending: c.messages.some((m) => m.pending),
  }));
  const active = activeConv();
  const s = S();
  return {
    conversations: list,
    activeId: active ? active.id : null,
    messages: active ? active.messages.map((m) => ({
      id: m.id, role: m.role, text: m.text || '', error: !!m.error, pending: !!m.pending,
      hasImage: !!m.image, at: m.at, source: m.source,
    })) : [],
    session: {
      running: session.running, mode: session.mode, busy: session.busy,
      displayName: session.displayName, idleSeconds: session.idleSeconds,
      nextFireAt: session.nextFireAt === Infinity ? null : session.nextFireAt,
      hotkeysOk: session.hotkeysOk, hotkeyError: session.hotkeyError,
      screenPermission: session.screenPermission,
    },
    hotkeys: { capture: s.hotkeyCapture, captureNew: s.hotkeyCaptureNew, toggleMode: s.hotkeyToggleMode },
    provider: s.provider,
    model: s.provider === 'gemini' ? s.geminiModel : s.provider === 'anthropic' ? s.anthropicModel : s.openaiModel,
    hasKey: !!(s.provider === 'gemini' ? s.geminiKey : s.provider === 'anthropic' ? s.anthropicKey : s.openaiKey),
    autoIdleSeconds: Number(s.autoIdleSeconds) || 45,
  };
}
function broadcastState() {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', publicState());
}
function toast(text, kind = 'info') {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('toast', { text, kind });
}
function notify(title, body) {
  if (!S().notifyOnAnswer || !Notification.isSupported()) return;
  try { new Notification({ title, body: body.slice(0, 200), silent: false }).show(); } catch (_) {}
}

// ---------- windows ----------
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 980, height: 720, minWidth: 640, minHeight: 420,
    title: 'Cheese1.0',
    backgroundColor: '#141416',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 16 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep UI updating while on another desktop
    },
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('closed', () => { mainWin = null; app.quit(); });
  applyWindowPrefs();
}

function applyWindowPrefs() {
  if (!mainWin) return;
  const s = S();
  mainWin.setVisibleOnAllWorkspaces(!!s.showOnAllDesktops, { visibleOnFullScreen: false });
  mainWin.setAlwaysOnTop(!!s.alwaysOnTop, 'floating');
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 600, height: 760, minWidth: 520, minHeight: 500,
    title: 'Cheese1.0 Settings', backgroundColor: '#141416',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------- background / "never become the active desktop" ----------
function enterBackgroundMode() {
  if (!mainWin) return;
  // Non-focusable: clicks still work, but the window never becomes key and the app never activates,
  // so macOS never switches Spaces to it.
  mainWin.setFocusable(false);
  mainWin.blur();
  if (IS_MAC && S().hideDockWhenRunning) app.dock.hide();
}
function exitBackgroundMode() {
  if (!mainWin) return;
  mainWin.setFocusable(true);
  if (IS_MAC) app.dock.show();
}

// ---------- hotkeys ----------
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const s = S();
  const bindings = [
    [s.hotkeyCapture, () => doCapture({ source: 'hotkey' })],
    [s.hotkeyCaptureNew, () => doCapture({ newConversation: true, source: 'hotkey' })],
    [s.hotkeyToggleMode, () => setMode(session.mode === 'auto' ? 'manual' : 'auto')],
  ];
  session.hotkeysOk = true; session.hotkeyError = '';
  for (const [accel, fn] of bindings) {
    if (!accel) continue;
    try {
      if (!globalShortcut.register(accel, fn)) throw new Error(`"${accel}" is already taken by another app`);
    } catch (e) {
      session.hotkeysOk = false; session.hotkeyError = e.message;
    }
  }
  broadcastState();
}

// ---------- auto mode ----------
function setMode(mode) {
  session.mode = mode === 'auto' ? 'auto' : 'manual';
  session.nextFireAt = Number(S().autoIdleSeconds) || 45;
  toast(session.mode === 'auto' ? `Auto mode: screenshot after ${session.nextFireAt}s idle` : 'Manual mode: use your hotkey', 'info');
  broadcastState();
}

function startAutoLoop() {
  clearInterval(session.autoTimer);
  session.autoTimer = setInterval(() => {
    const idle = powerMonitor.getSystemIdleTime(); // seconds since last mouse/keyboard input
    const changed = idle !== session.idleSeconds;
    session.idleSeconds = idle;
    const period = Number(S().autoIdleSeconds) || 45;
    if (idle < 2) session.nextFireAt = period; // user is active again → re-arm
    if (session.running && session.mode === 'auto' && idle >= session.nextFireAt) {
      session.nextFireAt = S().autoRepeat ? session.nextFireAt + period : Infinity;
      doCapture({ source: 'auto' });
    }
    if (changed) broadcastState();
  }, 1000);
}

// ---------- capture → AI ----------
async function doCapture({ newConversation: intoNew = false, source = 'manual' } = {}) {
  if (session.busy) { toast('Still waiting on the previous answer…', 'warn'); return; }
  session.busy = true; broadcastState();
  let conv = null, userMsg = null, botMsg = null;
  try {
    const img = await captureDisplay(session.displayId);
    if (source === 'auto' && S().autoSkipUnchanged) {
      const fp = fingerprint(img);
      if (fingerprintDiff(fp, session.lastFingerprint) < 2.5) { session.busy = false; broadcastState(); return; }
      session.lastFingerprint = fp;
    } else {
      session.lastFingerprint = fingerprint(img);
    }
    const b64 = toJpegBase64(img);

    conv = intoNew || !activeConv() ? newConversation(true) : activeConv();
    userMsg = { id: uid(), role: 'user', image: b64, at: Date.now(), source };
    botMsg = { id: uid(), role: 'assistant', text: '', pending: true, at: Date.now() };
    conv.messages.push(userMsg, botMsg);
    convStore.set({ activeId: conv.id });
    touch();

    const text = await askModel(S(), conv.messages.slice(0, -1));
    botMsg.text = text; botMsg.pending = false;
    if (conv.messages.filter((m) => m.role === 'assistant' && !m.error).length === 1) {
      conv.title = titleFrom(text);
    }
    touch();
    notify('Cheese answer ready', text.replace(/[*#`_]/g, '').trim());
  } catch (e) {
    console.error(e);
    if (botMsg) { botMsg.pending = false; botMsg.error = true; botMsg.text = e.message; touch(); }
    toast(e.message, 'error');
  } finally {
    session.busy = false; broadcastState();
  }
}
function titleFrom(text) {
  const line = text.split('\n').map((l) => l.replace(/[*#`_>]/g, '').trim()).find((l) => l.length > 2) || 'Chat';
  return line.length > 38 ? line.slice(0, 36) + '…' : line;
}

// ---------- screen sharing session ----------
function checkScreenPermission() {
  if (!IS_MAC) { session.screenPermission = 'granted'; return; }
  try { session.screenPermission = systemPreferences.getMediaAccessStatus('screen'); } catch { session.screenPermission = 'unknown'; }
}

async function listSources() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 480, height: 300 } });
  checkScreenPermission();
  const displays = screen.getAllDisplays();
  return sources.map((s, i) => {
    const d = displays.find((x) => String(x.id) === String(s.display_id));
    return {
      id: s.id, displayId: s.display_id || (d ? String(d.id) : ''), name: s.name || `Screen ${i + 1}`,
      size: d ? `${d.size.width}×${d.size.height}` : '',
      primary: d ? d.id === screen.getPrimaryDisplay().id : i === 0,
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    };
  });
}

function startSession({ displayId, name }) {
  session.running = true;
  session.displayId = displayId || String(screen.getPrimaryDisplay().id);
  session.displayName = name || 'Screen';
  session.mode = S().defaultMode === 'auto' ? 'auto' : 'manual';
  session.nextFireAt = Number(S().autoIdleSeconds) || 45;
  session.lastFingerprint = null;
  enterBackgroundMode();
  toast(`Sharing ${session.displayName}. The app will stay in the background from now on.`, 'ok');
  broadcastState();
}
function stopSession() {
  session.running = false;
  exitBackgroundMode();
  broadcastState();
}

// ---------- IPC ----------
function wireIpc() {
  ipcMain.handle('state:get', () => publicState());
  ipcMain.handle('sources:list', () => listSources());
  ipcMain.handle('session:start', (_e, p) => startSession(p || {}));
  ipcMain.handle('session:stop', () => stopSession());
  ipcMain.handle('mode:set', (_e, mode) => setMode(mode));
  ipcMain.handle('capture', (_e, p) => { doCapture({ ...(p || {}), source: 'button' }); });
  ipcMain.handle('conv:new', () => { newConversation(true); touch(); });
  ipcMain.handle('conv:select', (_e, id) => { convStore.set({ activeId: id }); broadcastState(); });
  ipcMain.handle('conv:delete', (_e, id) => {
    const list = conversations().filter((c) => c.id !== id);
    convStore.set({ conversations: list, activeId: list[0] ? list[0].id : null });
    broadcastState();
  });
  ipcMain.handle('conv:clear-all', () => { convStore.set({ conversations: [], activeId: null }); broadcastState(); });
  ipcMain.handle('message:image', (_e, { convId, msgId }) => {
    const c = conversations().find((x) => x.id === convId);
    const m = c && c.messages.find((x) => x.id === msgId);
    return m && m.image ? `data:image/jpeg;base64,${m.image}` : null;
  });
  ipcMain.handle('settings:get', () => ({ ...S(), defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT }));
  ipcMain.handle('settings:save', (_e, patch) => {
    settingsStore.set(patch); settingsStore.flush();
    registerHotkeys(); applyWindowPrefs();
    if (session.running && IS_MAC) { if (S().hideDockWhenRunning) app.dock.hide(); else app.dock.show(); }
    broadcastState();
    toast('Settings saved', 'ok');
  });
  ipcMain.handle('settings:open', () => openSettings());
  ipcMain.handle('settings:close', () => { if (settingsWin) settingsWin.close(); });
  ipcMain.handle('open:privacy', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'));
  ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
}

// ---------- app lifecycle ----------
app.whenReady().then(() => {
  settingsStore = new Store(app.getPath('userData'), 'settings', DEFAULT_SETTINGS);
  convStore = new Store(app.getPath('userData'), 'conversations', { conversations: [], activeId: null });
  if (!conversations().length) newConversation(true);

  // Minimal menu so Cmd+Q / Cmd+W still work in the settings window.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Cheese1.0', submenu: [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]));

  wireIpc();
  createMainWindow();
  registerHotkeys();
  startAutoLoop();
  checkScreenPermission();

  const s = S();
  const hasKey = s.openaiKey || s.geminiKey || s.anthropicKey;
  if (!hasKey) setTimeout(openSettings, 600);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearInterval(session.autoTimer);
  if (convStore) convStore.flush();
  if (settingsStore) settingsStore.flush();
});
app.on('window-all-closed', () => app.quit());
