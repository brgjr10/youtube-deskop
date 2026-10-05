'use strict';

const Module = require('module');

// Loads the real main.js against a fake `electron` so the handlers it registers
// can be asserted on without an Electron runtime. main.js holds all of its state
// at module scope, so each scenario re-requires it from a cleared cache.
const MAIN_PATH = require.resolve('../main.js');
const THEME_MARKER = 'data-ytdeskop-themed';

const createSession = () => {
  const session = {
    permissionRequestHandler: null,
    permissionCheckHandler: null,
    onHeadersReceived: null,
    webRequest: {
      onHeadersReceived(handler) {
        session.onHeadersReceived = handler;
      }
    }
  };

  session.setPermissionRequestHandler = function setPermissionRequestHandler(handler) {
    this.permissionRequestHandler = handler;
  };
  session.setPermissionCheckHandler = function setPermissionCheckHandler(handler) {
    this.permissionCheckHandler = handler;
  };

  return session;
};

const createFakeElectron = (overrides = {}) => {
  const state = {
    windows: [],
    appEvents: new Map(),
    switches: [],
    externalUrls: [],
    errorBoxes: [],
    quitCalls: 0,
    windowOpenHandler: null,
    webContentsEvents: new Map(),
    devToolsToggles: 0,
    restoreCalls: 0,
    focusCalls: 0,
    session: createSession(),
    isPackaged: false,
    singleInstanceLock: true,
    ready: Promise.resolve()
  };

  class FakeWebContents {
    constructor() {
      this.session = state.session;
      this.loadedUrls = [];
      this.loadUrlError = state.loadUrlError ?? null;
      this.insertedCss = [];
      this.devToolsAllowed = true;
      // A fake <html> so the theme dedup marker behaves like the real document.
      this.documentAttributes = new Set();
    }

    on(event, handler) {
      const handlers = state.webContentsEvents.get(event) ?? [];
      handlers.push(handler);
      state.webContentsEvents.set(event, handlers);
    }

    handlers(event) {
      return state.webContentsEvents.get(event) ?? [];
    }

    emit(event, ...args) {
      for (const handler of this.handlers(event)) handler(...args);
    }

    setWindowOpenHandler(handler) {
      state.windowOpenHandler = handler;
    }

    executeJavaScript(source) {
      const has = /hasAttribute\(/.test(source);
      const set = /setAttribute\(/.test(source);
      if (has) {
        return Promise.resolve(this.documentAttributes.has(THEME_MARKER));
      }
      if (set) {
        this.documentAttributes.add(THEME_MARKER);
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected executeJavaScript: ${source}`));
    }

    insertCSS(css) {
      this.insertedCss.push(css);
      return Promise.resolve();
    }

    loadURL(url) {
      this.loadedUrls.push(url);
      return this.loadUrlError ? Promise.reject(this.loadUrlError) : Promise.resolve();
    }

    toggleDevTools() {
      state.devToolsToggles += 1;
    }
  }

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeWebContents();
      this.minimized = false;
      state.windows.push(this);
    }

    static getAllWindows() {
      return state.windows;
    }

    loadURL(url) {
      return this.webContents.loadURL(url);
    }

    isMinimized() {
      return this.minimized;
    }

    restore() {
      this.minimized = false;
      state.restoreCalls += 1;
    }

    focus() {
      state.focusCalls += 1;
    }
  }

  const app = {
    isPackaged: state.isPackaged,
    commandLine: {
      appendSwitch(name, value) {
        state.switches.push([name, value]);
      }
    },
    requestSingleInstanceLock() {
      return state.singleInstanceLock;
    },
    whenReady() {
      return state.ready;
    },
    on(event, handler) {
      const handlers = state.appEvents.get(event) ?? [];
      handlers.push(handler);
      state.appEvents.set(event, handlers);
    },
    emit(event, ...args) {
      for (const handler of state.appEvents.get(event) ?? []) handler(...args);
    },
    quit() {
      state.quitCalls += 1;
    }
  };

  const electron = {
    app: Object.assign(app, overrides.app ?? {}),
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showErrorBox(title, content) {
        state.errorBoxes.push({ title, content });
      }
    },
    nativeTheme: { themeSource: null },
    shell: {
      openExternal(url) {
        state.externalUrls.push(url);
      }
    }
  };

  Object.assign(state, overrides.state ?? {});
  return { electron, state };
};

// Requires main.js with `electron` resolved to the fake, runs the module body,
// then lets the whenReady().then(createWindow) microtask drain. Console capture
// is owned by the caller so it stays open for events emitted after this returns.
const loadMain = async ({ electron, state }, { env = {} } = {}) => {
  const originalLoad = Module._load;
  const previousEnv = { ...process.env };

  delete require.cache[MAIN_PATH];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('YOUTUBE_')) delete process.env[key];
  }
  Object.assign(process.env, env);
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, ...rest);
  };

  try {
    require(MAIN_PATH);
    // Two turns: the first drains whenReady().then(createWindow), the second
    // drains the async theme marker check.
    await state.ready;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    Module._load = originalLoad;
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }

  return { state, window: state.windows[0] };
};

module.exports = { createFakeElectron, loadMain, THEME_MARKER };