const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, nativeTheme, shell, ipcMain, globalShortcut } = require('electron');

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

// Signing in to YouTube means signing in to Google: the "Sign in" link points
// at accounts.google.com, Google answers there and hands the browser back to
// youtube.com/signin. A window that refuses Google's pages, or sends them to
// the system browser, can never hold an account - so Google's identity pages
// are the one thing outside YouTube that stays inside the app. https only, and
// only on a Google-owned host.
const GOOGLE_AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'consent.google.com',
  'consent.youtube.com',
  'myaccount.google.com'
]);

// Google still serves some regional Accounts pages from a country domain, so
// accounts.google.co.uk has to be recognised as well. The country list is
// spelled out instead of being pattern-matched: a look-alike host such as
// accounts.google.evil.test is not a Google page and must not pass.
const REGIONAL_ACCOUNTS_HOSTS = new Set([
  'accounts.google.at', 'accounts.google.be', 'accounts.google.ca',
  'accounts.google.ch', 'accounts.google.co.in', 'accounts.google.co.jp',
  'accounts.google.co.nz', 'accounts.google.co.uk', 'accounts.google.co.za',
  'accounts.google.com.au', 'accounts.google.com.br', 'accounts.google.com.mx',
  'accounts.google.cz', 'accounts.google.de', 'accounts.google.dk',
  'accounts.google.es', 'accounts.google.fi', 'accounts.google.fr',
  'accounts.google.hu', 'accounts.google.ie', 'accounts.google.it',
  'accounts.google.nl', 'accounts.google.no', 'accounts.google.pl',
  'accounts.google.pt', 'accounts.google.ro', 'accounts.google.ru',
  'accounts.google.se', 'accounts.google.sg', 'accounts.google.tr'
]);

const isGoogleAuthUrl = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:') return false;
    return GOOGLE_AUTH_HOSTS.has(hostname) || REGIONAL_ACCOUNTS_HOSTS.has(hostname);
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

// Chromium reads Windows icon resources on Windows and nothing else. Handing
// it an .ico on Linux or macOS leaves the window with the generic Electron
// glyph, so those platforms get the PNG that was traced out of the same mark.
const iconPath = process.platform === 'win32'
  ? path.join(__dirname, 'youtube.ico')
  : path.join(__dirname, 'assets', 'youtube-desktop.png');

// --- Picture-in-Picture (PiP) support ---

// Global PiP window state
let pipWindow = null;
let mainWindow = null;

// Extract YouTube video ID from a URL
const extractVideoId = (url) => {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
    if (u.hostname.includes('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2];
      if (u.pathname.startsWith('/v/')) return u.pathname.split('/')[2];
    }
  } catch {
    return null;
  }
  return null;
};

// Get current video info from the main YouTube page
const getVideoInfo = async (win) => {
  const contents = win.webContents;
  try {
    const info = await contents.executeJavaScript(`
      (() => {
        // Try multiple ways to find the video element
        let video = document.querySelector('video');
        
        // YouTube may have video in shadow DOM or other containers
        if (!video) {
          // Walk up the tree to find any video element
          let node = document.body;
          while (node) {
            const found = node.querySelector('video');
            if (found) { video = found; break; }
            node = node.parentNode;
          }
        }
        
        if (!video) return null;
        
        let videoId = null;
        const url = window.location.href;
        
        // Try to get video ID from URL
        const match = url.match(/[?&]v=([^&]+)/) || url.match(/youtu\.be\/([^?&]+)/) || url.match(/\/embed\/([^?&]+)/);
        if (match) videoId = match[1];
        
        // Also try to get from video data attributes
        if (!videoId) {
          const match = video.getAttribute('data-video-id') || video.getAttribute('data-yt-id');
          if (match) videoId = match;
        }
        
        return {
          videoId,
          currentTime: video.currentTime,
          paused: video.paused,
          duration: video.duration
        };
      })()
    `);
    return info;
  } catch (error) {
    console.error('Failed to get video info:', error);
    return null;
  }
};

// Create PiP window
const createPipWindow = (videoId, seekTime = 0) => {
  if (pipWindow) {
    pipWindow.close();
    pipWindow = null;
  }

  const pipWin = new BrowserWindow({
    width: 480,
    height: 270,
    minWidth: 320,
    minHeight: 180,
    alwaysOnTop: true,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'pip-preload.js')
    },
  });

  pipWin.loadFile(path.join(__dirname, 'pip.html'), {
    query: { videoId, seekTime }
  }).catch((error) => {
    console.error('Failed to load PiP window:', error);
    pipWin.destroy();
    pipWindow = null;
  });

  pipWin.on('closed', () => {
    pipWindow = null;
    // Sync final state back to main window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pip-closed');
    }
  });

  pipWindow = pipWin;
  return pipWin;
};

// Toggle PiP - open or close
const togglePip = async (win) => {
  try {
    if (!win || win.isDestroyed()) {
      console.warn('togglePip called with invalid window');
      return;
    }

    if (pipWindow) {
      pipWindow.close();
      pipWindow = null;
      return;
    }

    const info = await getVideoInfo(win);
    if (!info || !info.videoId) {
      dialog.showErrorBox('YouTube Desktop', 'Could not find a video to picture-in-picture.\n\nMake sure a video is playing or paused.');
      return;
    }

    const pipWin = createPipWindow(info.videoId, Math.floor(info.currentTime));

    // If video was paused, pause the PiP window too
    if (info.paused && pipWin) {
      pipWin.webContents.once('did-finish-load', () => {
        pipWin.webContents.send('pip-command', { type: 'pause' });
      });
    }
  } catch (error) {
    console.error(`togglePip error: ${error.message}`);
    dialog.showErrorBox('YouTube Desktop', `Picture-in-picture failed: ${error.message}`);
  }
};

// IPC handlers (guarded for test environments without ipcMain)
if (ipcMain) {
  ipcMain.on('pip-action', (_event, action) => {
    if (!pipWindow || pipWindow.isDestroyed()) return;

    switch (action.type) {
      case 'load-video':
        pipWindow.webContents.send('pip-command', {
          type: 'load-video',
          videoId: action.videoId,
          seekTime: action.seekTime || 0
        });
        break;
      case 'play':
        pipWindow.webContents.send('pip-command', { type: 'play' });
        break;
      case 'pause':
        pipWindow.webContents.send('pip-command', { type: 'pause' });
        break;
      case 'seek-to':
        pipWindow.webContents.send('pip-command', { type: 'seek-to', time: action.time });
        break;
    }
  });
}

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

  mainWindow = win;

  if (isDev) registerDevToolsShortcut(win);

  gatePermissions(win.webContents.session);
  applyContentSecurityPolicy(win.webContents.session);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isYouTubeUrl(url)) return { action: 'allow' };
    if (isGoogleAuthUrl(url)) return { action: 'allow' };
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isYouTubeUrl(url)) return;
    if (isGoogleAuthUrl(url)) return;
    console.warn(`Blocked navigation away from YouTube: ${url}`);
    event.preventDefault();
  });

  win.webContents.on('did-create-window', (_event, authWindow, details) => {
    if (!isGoogleAuthUrl(details?.url ?? '')) return;

    let signedIn = false;

    authWindow.setTitle('Sign in to YouTube');
    authWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    authWindow.webContents.on('will-navigate', (navEvent, url) => {
      if (isYouTubeUrl(url) || isGoogleAuthUrl(url)) return;
      console.warn(`Blocked navigation in the sign-in window: ${url}`);
      navEvent.preventDefault();
    });
    authWindow.webContents.on('did-navigate', (_navEvent, url) => {
      if (!isYouTubeUrl(url)) return;
      signedIn = true;
      authWindow.close();
    });
    authWindow.on('closed', () => {
      if (!signedIn || win.isDestroyed()) return;
      win.webContents.reload();
    });
  });

  win.webContents.on('did-finish-load', () => {
    if (!isYouTubeUrl(win.webContents.getURL())) return;
    applyTheme(win.webContents);
  });

  // Handle window close - close PiP window too
  win.on('closed', () => {
    if (pipWindow) {
      pipWindow.close();
      pipWindow = null;
    }
    mainWindow = null;
  });

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

  app.whenReady().then(() => {
    createWindow();
    // Register global shortcut for PiP (Ctrl+Shift+P)
    if (globalShortcut) {
      try {
        const registered = globalShortcut.register('Control+Shift+P', () => {
          try {
            if (mainWindow) togglePip(mainWindow);
            else console.warn('PiP shortcut fired but mainWindow is null');
          } catch (error) {
            console.error(`PiP shortcut error: ${error.message}`);
          }
        });
        if (!registered) {
          console.warn('Failed to register Ctrl+Shift+P global shortcut (may conflict with another app)');
        } else {
          console.log('PiP shortcut Ctrl+Shift+P registered');
        }
      } catch (error) {
        console.error(`Failed to register PiP shortcut: ${error.message}`);
      }
    }
  }).catch((error) => {
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