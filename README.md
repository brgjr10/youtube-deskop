# YouTube Desktop

A native YouTube player for Windows & Linux built on Electron, wrapped in an **iOS 27 Liquid Glass** interface.

<img width="1280" height="640" alt="image" src="https://github.com/user-attachments/assets/2f03f14f-3c9d-4624-a015-93e6d8edca21" />

YouTube ships a solid light/dark web player that fights the rest of your desktop. This app loads the real `youtube.com` — every video, playlist, account and login works exactly as it does in a browser — then injects a glassmorphism stylesheet over the top, so the player looks like it belongs next to your other native windows instead of like a web page in a frame.

No accounts, no API keys, no browser chrome, no ads stripped by extension hacks. Just YouTube, in a window that matches the rest of your setup.

## Features

- **Liquid Glass theme** — a 1,900-line stylesheet generated from an iOS 27 userstyle, with three glass depths, 30px backdrop blur, rim-light hairlines and spring-curve animations. Every colour, radius, blur and easing resolves to a token in the `:root` block, so the whole theme can be re-tuned from one place.
- **Full site coverage** — the theme is re-applied on every page load, so home, search, subscriptions, the watch page, the sidebar, menus and popovers are all styled. YouTube's own SPA routing keeps the CSS alive in between.
- **Dark by default** — the renderer is pinned to `nativeTheme.themeSource = 'dark'`, so the theme never depends on the OS setting or YouTube's appearance preference.
- **Native window** — 1280x720, frameless chrome-free look with the menu bar auto-hidden and a bundled app icon.
- **Live theme editing** — `F12` (or `Ctrl+Shift+I` / `Ctrl+Shift+J`) opens DevTools, so the glass can be tuned in place instead of guessed at from screenshots.
- **Scriptable debugging** — set `YOUTUBE_APP_DEBUG_PORT` to expose the DevTools protocol for an external inspector or an automated styling check. Off by default.
- **One-command cross-platform build** — `npm run build` packages a self-contained `.exe` via `@electron/packager` on Windows (`win32`), and sets `PLATFORM=linux` in CI to build a Linux `.AppImage`. GitHub Actions builds both on every push and publishes a release on `v*` tags with both artifacts attached.

## Requirements

- [Node.js](https://nodejs.org) 20 or newer (Node 20 LTS recommended) — this is the floor
  `@electron/packager` imposes, not a preference.
- Windows 10/11, Linux (any modern distro). `scripts/build.js` defaults to `win32-x64`;
  set `PLATFORM=linux` to package a Linux `x64` build. Cross-platform packaging is
  controlled by `platform`/`arch` in `scripts/build.js`.

## Usage

```bash
npm install
npm start
```

To package the app:

```bash
# Windows build (default)
npm run build
# Output: dist/youtube-desktop-win32-x64/youtube-desktop.exe

# Linux build
PLATFORM=linux npm run build
# Output: dist/youtube-desktop-linux-x64/ (AppDir ready for AppImage)
```

GitHub Actions builds both artifacts on every push to `main`; push a `v1.2.3`-style tag to turn the run into a GitHub Release with both the Windows `.exe` and the Linux `.AppImage` attached.

## Customising the theme

`youtube-glass.css` is read from disk on every launch, so edits show up on restart without touching the launcher:

1. Run `npm start`.
2. Press `F12` to open DevTools on the live YouTube page.
3. Tweak the CSS, then copy the change back into `youtube-glass.css`.

The file is generated from a Stylus userstyle (`youtube.theme`); the `@-moz-document` wrapper and UserStyle metadata are stripped because Electron loads the stylesheet directly. Edit the source `.theme` and regenerate, or tweak the generated copy directly — the app reads it either way.

## The app icon

`youtube.ico` is the canonical artwork — the mark that ships with the Windows
executable. Chromium only reads Windows icon resources on Windows, so the same
mark is traced out of the `.ico` into the PNG and SVG assets the Linux and
macOS builds need:

```
assets/youtube-desktop.svg        scalable master, traced from the .ico
assets/youtube-desktop.png        256x256 raster, used as the window icon
assets/icons/<size>x<size>.png    hicolor theme set, 16 through 256
```

Regenerate them after changing `youtube.ico`:

```bash
python3 scripts/generate-icons.py
```

The script traces the mark, checks each traced shape against the pixels it came
from, and fails rather than writing a half-drawn icon. The PNGs are the source
of truth for the desktop entry, which points at the `youtube-desktop` icon in
the hicolor theme:

```bash
cp assets/icons/youtube-desktop-*.png ~/.local/share/icons/hicolor/<size>x<size>/apps/
```

## Building a Linux AppImage

The Linux build produces an AppDir in `dist/youtube-desktop-linux-x64/`. To turn it into a self-contained AppImage:

```bash
PLATFORM=linux npm run build
cd dist/appimage
wget -q https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage -O appimagetool
chmod +x appimagetool
./appimagetool --no-appstream . ../youtube-desktop-linux-x86_64.AppImage
```

The resulting `youtube-desktop-linux-x86_64.AppImage` runs on any x86_64 Linux with FUSE installed. It bundles its own Electron, Chromium, and the shared libraries it needs, so no system Electron is required.

## Project structure

```
main.js               Electron entry point — window creation, theme injection, DevTools
youtube-glass.css     The Liquid Glass theme, injected into every page load
youtube.ico           The app icon artwork, and the Windows icon resource
assets/               Icon assets traced out of youtube.ico for Linux and macOS
scripts/build.js      @electron/packager build, cross-platform (win32 default, linux via PLATFORM=)
scripts/generate-icons.py  Traces the icon assets out of youtube.ico
.github/workflows/    Build on push, release on tag
```

## Security

The renderer runs with `nodeIntegration: false`, `contextIsolation: true` and `sandbox: true`, so the YouTube page has no access to Node. Pop-outs and navigations away from `youtube.com` are refused, device permissions are allow-listed, and theme injection happens in the main process via `webContents.insertCSS` and never evaluates page-sourced code. DevTools are enabled by `npm start` only, never in the packaged app.

## License

ISC — see `package.json`.
