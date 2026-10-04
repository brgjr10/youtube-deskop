<img width="1919" height="1053" alt="YouTube Desktop running with the iOS 27 Liquid Glass theme" src="https://github.com/user-attachments/assets/906b93d1-9ac1-49de-bd54-04ceb40f65c0" />

# YouTube Desktop

A native YouTube player for Windows built on Electron, wrapped in an **iOS 27 Liquid Glass** interface.

YouTube ships a solid light/dark web player that fights the rest of your desktop. This app loads the real `youtube.com` — every video, playlist, account and login works exactly as it does in a browser — then injects a glassmorphism stylesheet over the top, so the player looks like it belongs next to your other native windows instead of like a web page in a frame.

No accounts, no API keys, no browser chrome, no ads stripped by extension hacks. Just YouTube, in a window that matches the rest of your setup.

## Features

- **Liquid Glass theme** — a 1,900-line stylesheet generated from an iOS 27 userstyle, with three glass depths, 30px backdrop blur, rim-light hairlines and spring-curve animations. Every colour, radius, blur and easing resolves to a token in the `:root` block, so the whole theme can be re-tuned from one place.
- **Full site coverage** — the theme is re-applied on every page load, so home, search, subscriptions, the watch page, the sidebar, menus and popovers are all styled. YouTube's own SPA routing keeps the CSS alive in between.
- **Dark by default** — the renderer is pinned to `nativeTheme.themeSource = 'dark'`, so the theme never depends on the OS setting or YouTube's appearance preference.
- **Native window** — 1280x720, frameless chrome-free look with the menu bar auto-hidden and a bundled app icon.
- **Live theme editing** — `F12` (or `Ctrl+Shift+I` / `Ctrl+Shift+J`) opens DevTools, so the glass can be tuned in place instead of guessed at from screenshots.
- **Scriptable debugging** — set `YOUTUBE_APP_DEBUG_PORT` to expose the DevTools protocol for an external inspector or an automated styling check. Off by default.
- **One-command Windows build** — `npm run build` packages a self-contained `.exe` via `electron-packager`. GitHub Actions builds on every push and publishes a release on `v*` tags.

## Requirements

- [Node.js](https://nodejs.org) 20 or newer (Node 22 recommended)
- Windows 10/11. The build script is pinned to `win32-x64`; cross-platform packaging is a matter of changing `platform`/`arch` in `scripts/build.js`.

## Usage

```bash
npm install
npm start
```

To package the app into a distributable Windows executable:

```bash
npm run build
```

The output lands in `dist/youtube-desktop-win32-x64/youtube-desktop.exe`. The same build runs in CI on every push to `main`; push a `v1.2.3`-style tag to turn the run into a GitHub Release with the executable attached.

## Customising the theme

`youtube-glass.css` is read from disk on every launch, so edits show up on restart without touching the launcher:

1. Run `npm start`.
2. Press `F12` to open DevTools on the live YouTube page.
3. Tweak the CSS, then copy the change back into `youtube-glass.css`.

The file is generated from a Stylus userstyle (`youtube.theme`); the `@-moz-document` wrapper and UserStyle metadata are stripped because Electron loads the stylesheet directly. Edit the source `.theme` and regenerate, or tweak the generated copy directly — the app reads it either way.

## Project structure

```
main.js               Electron entry point — window creation, theme injection, DevTools
youtube-glass.css     The Liquid Glass theme, injected into every page load
scripts/build.js      electron-packager build for win32-x64
.github/workflows/    Build on push, release on tag
```

## Security

The renderer runs with `nodeIntegration: false` and `contextIsolation: true`, so the YouTube page has no access to Node. Theme injection happens in the main process via `webContents.insertCSS` and never evaluates page-sourced code.

## License

ISC — see `package.json`.
