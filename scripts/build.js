const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const appDir = path.join(__dirname, '..');
const pkg = require(path.join(appDir, 'package.json'));
const packager = require('electron-packager');

const opts = {
  name: 'youtube-desktop',
  app: appDir,
  platform: 'win32',
  arch: 'x64',
  out: path.join(appDir, 'dist'),
  icon: path.join(appDir, 'youtube.ico'),
  executableName: 'youtube-desktop',
  prune: true,
  ignore: [
    '/scripts$',
    '/\\.git$',
    '/\\.github$',
    '/dist$',
    '/\\.cache$'
  ],
  appVersion: pkg.version,
  buildVersion: process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : 'dev'
};

(async () => {
  try {
    console.log('Packaging YouTube Desktop with options:', JSON.stringify(opts, null, 2));
    const paths = await packager(opts);
    console.log('Build complete:');
    paths.forEach((p) => console.log('  ' + p));
  } catch (err) {
    console.error('Build failed:', err.message);
    process.exit(1);
  }
})();