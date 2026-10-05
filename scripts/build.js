const path = require('path');

const appDir = path.join(__dirname, '..');
const pkg = require(path.join(appDir, 'package.json'));

const opts = {
  name: 'youtube-desktop',
  dir: appDir,
  platform: 'win32',
  arch: 'x64',
  out: path.join(appDir, 'dist'),
  icon: path.join(appDir, 'youtube.ico'),
  executableName: 'youtube-desktop',
  prune: true,
  // Ship the app sources as one archive instead of loose files. Electron patches
  // fs for asar, so the readFileSync of the theme still resolves. Stated
  // explicitly rather than leaning on the packager's default.
  asar: true,
  ignore: [
    '/scripts$',
    '/\\.git$',
    '/\\.github$',
    '/dist$',
    '/\\.cache$'
  ],
  // The win32 target takes both PE version fields from appVersion. buildVersion
  // is the macOS CFBundleVersion concept, and the packager maps it onto
  // file-version, where only a numeric dotted version is legal - a git SHA
  // stamped 47.0.0.0 and the literal 'dev' was rejected outright.
  appVersion: pkg.version
};

// A pending promise does not hold Node's event loop open, so a packager that
// stalls used to end the process with exit 0 and no artifact at all. Anything
// that has not reported back by the deadline is a failure, not a success.
// YOUTUBE_BUILD_TIMEOUT_MS overrides the ceiling (the build-gate test uses it).
const requestedTimeout = Number.parseInt(process.env.YOUTUBE_BUILD_TIMEOUT_MS ?? '', 10);
const PACKAGE_TIMEOUT_MS = Number.isInteger(requestedTimeout) && requestedTimeout > 0
  ? requestedTimeout
  : 10 * 60 * 1000;

(async () => {
  let timeoutId;
  try {
    console.log('Packaging YouTube Desktop with options:', JSON.stringify(opts, null, 2));
    // @electron/packager is ESM-only, so it has to be pulled in dynamically.
    const { packager } = await import('@electron/packager');
    const paths = await Promise.race([
      packager(opts),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`packaging did not finish within ${PACKAGE_TIMEOUT_MS / 1000} seconds`)),
          PACKAGE_TIMEOUT_MS
        );
      })
    ]);
    console.log('Build complete:');
    paths.forEach((p) => console.log('  ' + p));
  } catch (err) {
    console.error('Build failed:', err.message);
    process.exit(1);
  } finally {
    // A pending timer holds the event loop open exactly as long as its deadline,
    // so an uncleared one makes a successful build look hung for the full 10
    // minutes after it has already printed "Build complete".
    clearTimeout(timeoutId);
  }
})();