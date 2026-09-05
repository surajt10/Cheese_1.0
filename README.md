# Cheese1.0

A macOS app you never type to. It lives on its own desktop, watches the screen you share with it, and every screenshot — taken with a hotkey or automatically when you go idle — is sent to an AI (OpenAI / Gemini / Claude) whose answer appears in a ChatGPT-style tabbed conversation inside the app.

## Build the DMG (one time, on your Mac)

You need [Node.js](https://nodejs.org) (LTS) installed. Then, in Terminal:

```bash
cd cheese
npm install
npm run dist          # builds both Apple Silicon and Intel DMGs
# or: npm run dist:arm   (Apple Silicon only, faster)
```

The DMGs land in `dist/` — e.g. `dist/Cheese1.0-1.0.0-arm64.dmg`. Open it, drag Cheese1.0 to Applications.

To run without building: `npm start`.

### First launch on macOS

The app is not code-signed (that needs a paid Apple developer account), so the first time:

1. Right-click **Cheese1.0.app** → **Open** → **Open**. (Or, if macOS says it's "damaged", run once in Terminal: `xattr -cr /Applications/Cheese1.0.app`.)
2. When you click **Start screen share**, macOS asks for **Screen Recording** permission → allow it in System Settings → Privacy & Security → Screen Recording, then relaunch Cheese. Without it, screenshots come out black.

## Using it

1. **Settings** (⚙ top right, or ⌘,): pick a provider, paste your API key. The Settings window is the only place you ever type.
2. **Start screen share** → pick a screen. From this moment the app runs in the background: it stops being focusable, hides its Dock icon, and never becomes the active window/desktop.
3. **Give it its own desktop**: open Mission Control (3-finger swipe up or F3), drag the Cheese window onto the "+" at the top-right to create a new Desktop. Now a *partial* 4-finger horizontal swipe on the trackpad peeks at it without switching — release and you snap back. Because Cheese never takes focus, macOS never jumps to that desktop on its own.
4. **Manual mode** (default): press the hotkey from any app.
   - `⌘⇧1` – screenshot into the active conversation tab
   - `⌘⇧2` – screenshot into a brand-new tab
   - `⌘⇧3` – toggle Auto / Manual
   All three are changeable in Settings.
5. **Auto mode**: once sharing is running, a screenshot is taken whenever there's been no mouse/keyboard input for 45 s (configurable), and again every 45 s while you stay idle. Unchanged screens are skipped so you don't pay for duplicate answers.
6. Each tab is a conversation; every screenshot in a tab is sent along with the earlier ones (last 4 images by default) so follow-up screenshots build on previous answers. `+` makes a new tab, `✕` closes one. Click a screenshot to view it full size. A macOS notification tells you when an answer lands, so you don't need to look at the Cheese desktop until it's ready.

## How it works

| Piece | Implementation |
|---|---|
| Screenshot | `desktopCapturer` grabs the chosen display at native resolution, downscaled to 1600 px and JPEG-encoded before upload (`capture.js`) |
| Hotkeys | Electron `globalShortcut` — system-wide, works while another app is frontmost |
| Auto mode | `powerMonitor.getSystemIdleTime()` polled every second; 32×32 grayscale fingerprint diff skips unchanged screens |
| Never takes focus | after sharing starts: `BrowserWindow.setFocusable(false)` + `app.dock.hide()` — clicks still work, but the window is never key and the app is never activated, which is exactly the condition macOS uses to switch Spaces |
| AI | plain `fetch` to OpenAI Chat Completions, Gemini `generateContent`, or Anthropic Messages, with images inline (`providers.js`) |
| Storage | `~/Library/Application Support/Cheese1.0/` — `settings.json` (keys live here, on your machine only) and `conversations.json` |

## Project layout

```
main.js            main process: windows, hotkeys, auto loop, sessions, IPC
capture.js         screenshot + fingerprinting
providers.js       OpenAI / Gemini / Anthropic calls, history trimming
store.js           tiny JSON store
preload.js         safe IPC bridge
index.html/app.js/style.css   chat UI
settings.html/settings.js     settings window
icon.png           app icon
test.js            unit tests (`npm test`)
```
