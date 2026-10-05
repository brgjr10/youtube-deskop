'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createFakeElectron, loadMain, THEME_MARKER } = require('./harness');

const repoRoot = path.join(__dirname, '..');

// main.js logs everything it cannot recover from. Capture the whole suite so a
// test can assert on what a user would never see.
const consoleLines = [];
const realError = console.error;
const realWarn = console.warn;
console.error = (...args) => consoleLines.push(args.join(' '));
console.warn = (...args) => consoleLines.push(args.join(' '));
test.after(() => {
  console.error = realError;
  console.warn = realWarn;
});

const logged = (fragment) => consoleLines.some((line) => line.includes(fragment));
const settle = () => new Promise((resolve) => setImmediate(resolve));

// YTDESKOP-003
test('setWindowOpenHandler is registered and denies every pop-out', async () => {
  const session = createFakeElectron();
  const { state, window } = await loadMain(session);

  assert.ok(state.windowOpenHandler, 'no setWindowOpenHandler registered');

  // A remote origin must not be able to spawn a second native window.
  assert.deepStrictEqual(
    state.windowOpenHandler({ url: 'https://example.com/' }),
    { action: 'deny' }
  );
  assert.equal(state.windows.length, 1, 'a second BrowserWindow was created');

  // Genuine YouTube pop-outs go to the OS browser, still never to a new window.
  assert.deepStrictEqual(
    state.windowOpenHandler({ url: 'https://www.youtube.com/watch?v=abc' }),
    { action: 'deny' }
  );
  assert.deepStrictEqual(state.externalUrls, ['https://www.youtube.com/watch?v=abc']);
  assert.equal(state.windows.length, 1, 'a YouTube pop-out still opened a window');

  // A look-alike host must not be treated as YouTube.
  assert.deepStrictEqual(
    state.windowOpenHandler({ url: 'https://www.youtube.com.evil.test/' }),
    { action: 'deny' }
  );
  assert.equal(state.externalUrls.length, 1, 'a look-alike host was handed to openExternal');

  assert.deepStrictEqual(
    state.windowOpenHandler({ url: 'javascript:alert(1)' }),
    { action: 'deny' }
  );
  assert.equal(state.externalUrls.length, 1, 'a javascript: URL was handed to openExternal');
});

// YTDESKOP-004
test('setPermissionRequestHandler allow-lists and denies by default', async () => {
  const session = createFakeElectron();
  const { state } = await loadMain(session);

  assert.ok(state.session.permissionRequestHandler, 'no setPermissionRequestHandler registered');
  assert.ok(state.session.permissionCheckHandler, 'no setPermissionCheckHandler registered');

  const decide = (permission) => {
    let answer = null;
    state.session.permissionRequestHandler(null, permission, (granted) => {
      answer = granted;
    });
    return answer;
  };

  assert.strictEqual(decide('media'), true);
  assert.strictEqual(decide('fullscreen'), true);
  assert.strictEqual(decide('clipboard-sanitized-write'), true);
  assert.strictEqual(decide('geolocation'), false);
  assert.strictEqual(decide('notifications'), false);
  assert.strictEqual(decide('midi'), false);
  assert.strictEqual(decide('openExternal'), false);

  assert.strictEqual(state.session.permissionCheckHandler(null, 'media'), true);
  assert.strictEqual(state.session.permissionCheckHandler(null, 'geolocation'), false);
});

// YTDESKOP-005
test('will-navigate refuses to leave YouTube and CSP is injected', async () => {
  const session = createFakeElectron();
  const { state, window } = await loadMain(session);

  assert.ok(window.webContents.handlers('will-navigate').length === 1, 'no will-navigate guard registered');

  const guard = window.webContents.handlers('will-navigate')[0];
  let prevented = 0;
  const attempt = (url) => guard({ preventDefault: () => { prevented += 1; } }, url);

  attempt('https://www.youtube.com/watch?v=abc');
  assert.strictEqual(prevented, 0, 'a YouTube navigation was blocked');

  attempt('https://accounts.google.com/ServiceLogin');
  assert.strictEqual(prevented, 1, 'an off-YouTube navigation was allowed');

  attempt('https://evil.test/');
  assert.strictEqual(prevented, 2, 'an off-YouTube navigation was allowed');

  assert.ok(state.session.onHeadersReceived, 'no onHeadersReceived registered');
  let headers = null;
  state.session.onHeadersReceived(
    { responseHeaders: { 'Content-Type': ['text/html'] } },
    (result) => { headers = result.responseHeaders; }
  );
  const csp = headers['Content-Security-Policy'];
  assert.ok(Array.isArray(csp) && csp.length === 1, 'CSP header missing');
  assert.match(csp[0], /object-src 'none'/);
  assert.match(csp[0], /default-src[^;]*https:/);
  assert.deepStrictEqual(headers['Content-Type'], ['text/html'], 'existing headers were dropped');
});

// YTDESKOP-006
test('a rejected loadURL surfaces an error instead of a blank window', async () => {
  const session = createFakeElectron({
    state: { loadUrlError: new Error('ERR_NAME_NOT_RESOLVED during API resolution') }
  });
  const { state, window } = await loadMain(session);

  assert.deepStrictEqual(window.webContents.loadedUrls, ['https://youtube.com']);
  assert.ok(logged('Could not load YouTube: ERR_NAME_NOT_RESOLVED'), 'the load failure was not logged');
  assert.equal(state.errorBoxes.length, 1, 'the user was not shown the load failure');
  assert.match(state.errorBoxes[0].title, /YouTube Desktop/);
  assert.match(state.errorBoxes[0].content, /ERR_NAME_NOT_RESOLVED/);
});

// YTDESKOP-014
test('an unreadable stylesheet is reported to the user, once', async () => {
  const originalReadFileSync = fs.readFileSync;
  const themePath = path.join(repoRoot, 'youtube-glass.css');
  let reads = 0;

  fs.readFileSync = (target, ...rest) => {
    if (String(target).endsWith('youtube-glass.css')) {
      reads += 1;
      const error = new Error('ENOENT: no such file or directory');
      error.code = 'ENOENT';
      throw error;
    }
    return originalReadFileSync(target, ...rest);
  };

  try {
    const session = createFakeElectron();
    const { state, window } = await loadMain(session);

    // Nothing reads the theme until the first page load completes.
    assert.equal(reads, 0, 'the theme was read before anything needed it');

    window.webContents.emit('did-finish-load');
    await settle();

    assert.ok(logged('Glass theme not loaded'), 'the read failure was not logged');
    assert.equal(state.errorBoxes.length, 1, 'the user was not told exactly once');
    assert.match(state.errorBoxes[0].content, /youtube-glass\.css/);
    assert.equal(window.webContents.insertedCss.length, 0, 'CSS was injected without a theme');

    window.webContents.documentAttributes = new Set();
    window.webContents.emit('did-finish-load');
    await settle();
    assert.equal(state.errorBoxes.length, 1, 'the dialog was repeated on the next load');
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

// YTDESKOP-015
test('devTools and the F12 shortcut are dev-only', async () => {
  const packaged = createFakeElectron({ app: { isPackaged: true } });
  const packagedRun = await loadMain(packaged);

  assert.strictEqual(packagedRun.window.options.webPreferences.devTools, false);
  assert.equal(
    packagedRun.window.webContents.handlers('before-input-event').length,
    0,
    'the DevTools shortcut is registered in a packaged build'
  );

  const dev = createFakeElectron({ app: { isPackaged: false } });
  const devRun = await loadMain(dev);
  assert.strictEqual(devRun.window.options.webPreferences.devTools, true);
  assert.equal(devRun.window.webContents.handlers('before-input-event').length, 1, 'devTools shortcut missing under npm start');
});

// YTDESKOP-020
test('the theme is applied once per document, not once per did-finish-load', async () => {
  const session = createFakeElectron();
  const { window } = await loadMain(session);
  const contents = window.webContents;

  for (let i = 0; i < 5; i += 1) {
    contents.emit('did-finish-load');
    await settle();
  }
  assert.equal(contents.insertedCss.length, 1, 'the theme was injected into the same document twice');

  // YouTube swaps the document on a hard navigation; the new one needs the theme.
  contents.documentAttributes = new Set();
  contents.emit('did-finish-load');
  await settle();
  assert.equal(contents.insertedCss.length, 2, 'a new document did not get the theme');
});

// YTDESKOP-021
test('the theme file is read once and re-read only when it changes', async () => {
  const originalReadFileSync = fs.readFileSync;
  let themeReads = 0;
  fs.readFileSync = (target, ...rest) => {
    if (String(target).endsWith('youtube-glass.css')) {
      themeReads += 1;
      return originalReadFileSync(target, ...rest);
    }
    return originalReadFileSync(target, ...rest);
  };

  try {
    const session = createFakeElectron();
    const { window } = await loadMain(session);
    const contents = window.webContents;

    for (let i = 0; i < 5; i += 1) {
      contents.documentAttributes = new Set();
      contents.emit('did-finish-load');
      await settle();
    }
    assert.equal(themeReads, 1, `the 68 KB theme was read ${themeReads} times`);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

// YTDESKOP-022
test('an activate handler brings a window back on macOS', async () => {
  const session = createFakeElectron();
  const { state } = await loadMain(session);

  assert.ok(state.appEvents.has('activate'), 'no activate handler registered');

  state.windows.length = 0;
  state.appEvents.get('activate').forEach((handler) => handler());
  assert.equal(state.windows.length, 1, 'activate did not recreate the window');

  state.appEvents.get('activate').forEach((handler) => handler());
  assert.equal(state.windows.length, 1, 'activate created a duplicate window');
});

// YTDESKOP-023
test('a second launch focuses the running window instead of opening another', async () => {
  const second = createFakeElectron({
    app: { requestSingleInstanceLock: () => false }
  });
  const refused = await loadMain(second);

  assert.strictEqual(refused.state.quitCalls, 1, 'the second instance did not quit');
  assert.equal(refused.state.windows.length, 0, 'the second instance opened a window');
  assert.equal(refused.state.appEvents.has('second-instance'), false);

  const first = createFakeElectron();
  const running = await loadMain(first);
  first.state.windows[0].minimized = true;
  first.state.appEvents.get('second-instance').forEach((handler) => handler());
  assert.strictEqual(running.state.restoreCalls, 1, 'the minimized window was not restored');
  assert.strictEqual(running.state.focusCalls, 1, 'the running window was not focused');
});

// YTDESKOP-024
test('YOUTUBE_APP_DEBUG_PORT is validated before it reaches Chromium', async () => {
  const good = createFakeElectron();
  const goodRun = await loadMain(good, { env: { YOUTUBE_APP_DEBUG_PORT: '18110' } });
  assert.deepStrictEqual(goodRun.state.switches, [['remote-debugging-port', '18110']]);

  for (const bad of ['abc', '70000', '80', '', '18110 18111']) {
    const session = createFakeElectron();
    const run = await loadMain(session, { env: { YOUTUBE_APP_DEBUG_PORT: bad } });
    assert.deepStrictEqual(run.state.switches, [], `"${bad}" was forwarded to Chromium`);
  }

  const unset = createFakeElectron();
  const unsetRun = await loadMain(unset);
  assert.deepStrictEqual(unsetRun.state.switches, [], 'a debug port was set with no env var');
});

// YTDESKOP-026 + the renderer-isolation regression bar
test('renderer isolation is intact', async () => {
  const session = createFakeElectron();
  const { window } = await loadMain(session);
  const prefs = window.options.webPreferences;

  assert.strictEqual(prefs.nodeIntegration, false, 'nodeIntegration was enabled');
  assert.strictEqual(prefs.contextIsolation, true, 'contextIsolation was disabled');
  assert.strictEqual(prefs.sandbox, true, 'the renderer is not sandboxed');

  const source = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');
  assert.doesNotMatch(source, /nodeIntegration:\s*true/, 'main.js enables nodeIntegration somewhere');
  assert.doesNotMatch(source, /contextIsolation:\s*false/, 'main.js disables contextIsolation somewhere');
});

// YTDESKOP-017 / -018 / -019 / -027 and the build gate
test('the build script carries no buildVersion and ignores packager leftovers', () => {
  const buildSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'build.js'), 'utf8');
  assert.match(buildSource, /appVersion: pkg\.version/);
  assert.match(buildSource, /asar: true/);
  assert.doesNotMatch(buildSource, /buildVersion\s*:/, 'buildVersion is still a packager option');
  assert.doesNotMatch(buildSource, /spawnSync/, 'the dead child_process import is still there');
  assert.doesNotMatch(buildSource, /require\('fs'\)/, 'the dead fs import is still there');

  const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /\*-template-\*\//, 'packager staging leftovers are not ignored');
  assert.match(gitignore, /\*\.log/, '*.log is not ignored');

  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-release.yml'), 'utf8');
  assert.doesNotMatch(workflow, /GITHUB_SHA/, 'the workflow still stamps a git SHA into the build');
});

test('the build exits non-zero with a diagnostic when packaging stalls', () => {
  // The defect: extract-zip never settled, a pending promise did not hold the
  // event loop open, and the build exited 0 having produced nothing. This runs
  // the real scripts/build.js against a stub packager, so it needs no
  // dependencies and works from any checkout.
  const runBuild = (packagerSource) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdeskop-build-'));
    fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
    const stub = path.join(work, 'node_modules', '@electron', 'packager');
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(
      path.join(work, 'package.json'),
      JSON.stringify({ name: 'build-gate-fixture', version: '1.0.0', type: 'commonjs' })
    );
    fs.writeFileSync(
      path.join(stub, 'package.json'),
      JSON.stringify({ name: '@electron/packager', version: '20.3.0', type: 'module', exports: { '.': './index.js' } })
    );
    fs.writeFileSync(path.join(stub, 'index.js'), packagerSource);
    fs.copyFileSync(path.join(repoRoot, 'scripts', 'build.js'), path.join(work, 'scripts', 'build.js'));

    try {
      const stdout = execFileSync(process.execPath, ['scripts/build.js'], {
        cwd: work,
        env: { ...process.env, YOUTUBE_BUILD_TIMEOUT_MS: '250' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return { status: 0, output: stdout };
    } catch (error) {
      return { status: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  };

  const stalled = runBuild('export const packager = () => new Promise(() => {});\n');
  assert.notStrictEqual(stalled.status, 0, `a stalled build reported success:\n${stalled.output}`);
  assert.match(stalled.output, /Build failed: .*did not finish/, `no diagnostic:\n${stalled.output}`);

  // Guard against a script that simply always fails, and check the options the
  // packager is actually handed.
  const finished = runBuild("export const packager = async () => ['C:/dist/youtube-desktop-win32-x64'];\n");
  assert.strictEqual(finished.status, 0, `a completed build failed:\n${finished.output}`);
  assert.match(finished.output, /Build complete:/);

  const options = JSON.parse(finished.output.slice(
    finished.output.indexOf('{'),
    finished.output.indexOf('}', finished.output.indexOf('"ignore"')) + 1
  ));
  assert.ok(!('buildVersion' in options), `buildVersion is still an option: ${JSON.stringify(options)}`);
  assert.strictEqual(options.appVersion, require(path.join(repoRoot, 'package.json')).version);
  assert.strictEqual(options.asar, true);
});