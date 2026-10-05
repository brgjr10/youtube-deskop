const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, nativeTheme, shell } = require('electron');
// The glass theme lives beside this file so it can be edited without touching
// the launcher. Electron's insertCSS only applies to the document that is
// loaded at the time, so it has to be re-applied every time YouTube swaps the
// document out (its own SPA routing keeps the CSS alive in between).
const themePath = path.join(__dirname, 'youtube-glass.css');

// This window is YouTube in a frame, not a browser. Anything the page tries to
// open or navigate to outside the YouTube origins is refused, so no origin can
// present a second native window wearing this app's name, icon and glass chrome
// with no browser UI to tell it apart.
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

const isYouTubeUrl = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && YOUTUBE_HOSTS.has(hostname);
  } catch {
    return false;
  }
};

// DevTools stay reachable so the theme can be inspected and tuned in place
// instead of guessing from a screenshot - in development only. The packaged
// app ships without the preference and without the shortcut.
const isDev = !app.isPackaged;

let themeCache = null;
let themeFailureReported = false;

const readTheme = () => {
  if (themeCache !== null) return themeCache;

  try {
    themeCache = fs.readFileSync(themePath, 'utf8');
  } catch (error) {
    // A double-clicked .exe has no console attached, so an unreadable theme
    // would otherwise be a silent, unthemed YouTube with nothing to explain it.
    console.error(`Glass theme not loaded from ${themePath}: ${error.message}`);
    if (!themeFailureReported) {
      themeFailureReported = true;
      dialog.showErrorBox('YouTube Desktop', `The glass theme could not be read from:\n${themePath}\n\n${error.message}\n\nThe app will run without it.`);
    }
  }

  return themeCache;
};

// 68 KB of synchronous main-process I/O on every page load buys nothing. Cache it
// and let the dev-only live-edit workflow invalidate the cache instead, so an
// edit still shows up without restarting.
const watchTheme = () => {
  try {
    // persistent: false so a dev-only live-edit watcher is never what keeps the
    // process alive. Electron's own lifecycle holds the app open, and a persistent
    // fs.watch handle would otherwise stop the main process - and the test suite,
    // which loads this same module - from ever exiting.
    const watcher = fs.watch(themePath, { persistent: false }, () => {
      themeCache = null;
    });
    // watch() reports a late failure asynchronously, where the try/catch above
    // cannot see it. Without a listener that is an unhandled 'error' event.
    watcher.on('error', (error) => {
      console.warn(`Stopped watching ${themePath} for changes: ${error.message}`);
    });
  } catch (error) {
    console.warn(`Not watching ${themePath} for changes: ${error.message}`);
  }
};

// YouTube hands back a fresh document on every hard navigation, so each one
// needs the theme exactly once - the marker attribute is how a repeat is told
// apart from a new document.
const THEME_MARKER = 'data-ytdeskop-themed';

// Serialised so two loads landing back to back cannot both read the document as
// unthemed before either has written the marker.
let themeQueue = Promise.resolve();

const themeDocument = async (contents) => {
  const alreadyThemed = await contents.executeJavaScript(
    `document.documentElement.hasAttribute(${JSON.stringify(THEME_MARKER)})`
  ).catch(() => false);
  if (alreadyThemed) return;

  const theme = readTheme();
  if (!theme) return;

  contents.insertCSS(theme).catch((error) => {
    console.error(`Glass theme injection failed: ${error.message}`);
  });
  contents.executeJavaScript(
    `document.documentElement.setAttribute(${JSON.stringify(THEME_MARKER)}, '')`
  ).catch((error) => {
    console.error(`Glass theme marker could not be set: ${error.message}`);
  });
};

const applyTheme = (contents) => {
  themeQueue = themeQueue.then(() => themeDocument(contents)).catch((error) => {
    console.error(`Glass theme not applied: ${error.message}`);
  });
  return themeQueue;
};

const registerDevToolsShortcut = (win) => {
  win.webContents.on('before-input-event', (event, input) => {
    const isToggle = input.key === 'F12'
      || (input.control && input.shift && ['i', 'j'].includes(input.key.toLowerCase()));

    if (!isToggle) return;

    event.preventDefault();
    win.webContents.toggleDevTools();
  });
};

// YouTube legitimately uses the camera and mic for uploads and
// picture-in-picture, so those stay allowed. Geolocation, notifications and the
// rest are denied instead of raising a native prompt inside a window the user
// has no reason to distrust.
const ALLOWED_PERMISSIONS = new Set(['media', 'fullscreen', 'clipboard-sanitized-write']);

const gatePermissions = (session) => {
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.has(permission));
};

// YouTube's own markup needs a wide script-src, so this is deliberately a
// conservative policy: it keeps today's behaviour and closes the plugin and
// base-tag holes. frame-ancestors is left out on purpose - the window is always
// a top-level frame, and the header would also apply to YouTube's own embedded
// frames.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:",
  "object-src 'none'",
  "base-uri 'self'"
].join('; ');

const applyContentSecurityPolicy = (session) => {
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY]
      }
    });
  });
};

const iconPath = path.join(__dirname, 'youtube.ico');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: isDev
    }
  });

  if (isDev) registerDevToolsShortcut(win);

  gatePermissions(win.webContents.session);
  applyContentSecurityPolicy(win.webContents.session);

  // Deny by default; a genuine YouTube pop-out goes to the user's real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isYouTubeUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isYouTubeUrl(url)) return;
    console.warn(`Blocked navigation away from YouTube: ${url}`);
    event.preventDefault();
  });

  win.webContents.on('did-finish-load', () => applyTheme(win.webContents));

  win.loadURL('https://youtube.com').catch((error) => {
    console.error(`Could not load YouTube: ${error.message}`);
    dialog.showErrorBox('YouTube Desktop', `Could not reach youtube.com.\n\n${error.message}`);
  });
}

// The theme paints a dark page, so pin the renderer to dark instead of
// depending on the OS theme or the YouTube appearance setting.
nativeTheme.themeSource = 'dark';

if (isDev) watchTheme();

// Set YOUTUBE_APP_DEBUG_PORT to expose the DevTools protocol (for an external
// inspector or an automated styling check); off by default.
const debugPortSetting = process.env.YOUTUBE_APP_DEBUG_PORT;
if (debugPortSetting) {
  // Number(), not parseInt(): parseInt accepts a trailing garbage suffix, which
  // would hand Chromium a port nobody asked for.
  const debugPort = Number(debugPortSetting);
  if (Number.isInteger(debugPort) && debugPort >= 1024 && debugPort <= 65535) {
    app.commandLine.appendSwitch('remote-debugging-port', String(debugPort));
  } else {
    console.warn(`Ignoring YOUTUBE_APP_DEBUG_PORT="${debugPortSetting}": expected an integer from 1024 to 65535.`);
  }
}

// A second launch would open another full renderer and another YouTube session,
// so focus the window that is already running instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(createWindow).catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    dialog.showErrorBox('YouTube Desktop', `The app failed to start.\n\n${error.message}`);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// macOS keeps the process alive with no windows, so the dock icon has to be
// able to bring one back.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});