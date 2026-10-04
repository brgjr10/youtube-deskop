const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeTheme } = require('electron');
// The glass theme lives beside this file so it can be edited without touching
// the launcher. Electron's insertCSS only applies to the document that is
// loaded at the time, so it has to be re-applied every time YouTube swaps the
// document out (its own SPA routing keeps the CSS alive in between).
const themePath = path.join(__dirname, 'youtube-glass.css');

const readTheme = () => {
  try {
    return fs.readFileSync(themePath, 'utf8');
  } catch (error) {
    console.error(`Glass theme not loaded from ${themePath}: ${error.message}`);
    return '';
  }
};

const applyTheme = (contents) => {
  const theme = readTheme();
  if (!theme) return;

  contents.insertCSS(theme).catch((error) => {
    console.error(`Glass theme injection failed: ${error.message}`);
  });
};

// DevTools stay reachable so the theme can be inspected and tuned in place
// instead of guessing from a screenshot.
const registerDevToolsShortcut = (win) => {
  win.webContents.on('before-input-event', (event, input) => {
    const isToggle = input.key === 'F12'
      || (input.control && input.shift && ['i', 'j'].includes(input.key.toLowerCase()));

    if (!isToggle) return;

    event.preventDefault();
    win.webContents.toggleDevTools();
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
      devTools: true
    }
  });

  registerDevToolsShortcut(win);
  win.webContents.on('did-finish-load', () => applyTheme(win.webContents));

  win.loadURL('https://youtube.com');
}

// The theme paints a dark page, so pin the renderer to dark instead of
// depending on the OS theme or the YouTube appearance setting.
nativeTheme.themeSource = 'dark';

// Set YOUTUBE_APP_DEBUG_PORT to expose the DevTools protocol (for an external
// inspector or an automated styling check); off by default.
if (process.env.YOUTUBE_APP_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.YOUTUBE_APP_DEBUG_PORT);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
