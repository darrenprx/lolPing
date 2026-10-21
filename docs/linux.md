# Linux (experimental X11 port)

This source tree adds a Linux backend to lolPing 0.5.1. It is a local development port; upstream releases may not contain Linux packages yet.

## Requirements

- x86-64 Linux; development and package validation use Ubuntu 24.04.
- A genuine **X11 desktop session**, with a compositor for transparent overlays. Choose **Ubuntu on Xorg** / an X11 session at login. Running an XWayland window inside a Wayland session is insufficient: it cannot capture native Wayland application input. The helper reports this limitation instead of silently running with partial input.
- XInput 2.1, XTest, and the usual Electron desktop libraries. No root privileges or access to `/dev/input` are needed to run the input helper.
- GNOME needs its AppIndicator extension to display the tray. Ubuntu normally includes this extension. Other desktops need a system tray.

## Build

Install Node.js **22.12 or newer** and a C++20 compiler. On Ubuntu/Debian:

```sh
sudo apt-get install build-essential libx11-dev libxi-dev libxtst-dev
npm ci
npm run build:helper
npx install-electron
npm run dev
```

Build distributables on Linux:

```sh
npm run dist:linux
```

This produces `release/lolPing-<version>-x86_64.AppImage`, `release/lolPing-<version>-amd64.deb`, and the unpacked application in `release/linux-unpacked/`.

```sh
# Debian / Ubuntu installation
sudo apt install ./release/lolPing-0.5.1-amd64.deb

# Portable build (requires FUSE support and Electron sandbox support on the host)
chmod +x release/lolPing-0.5.1-x86_64.AppImage
./release/lolPing-0.5.1-x86_64.AppImage
```

On Ubuntu versions that restrict unprivileged user namespaces, prefer the installed `.deb` if the portable build reports a Chromium sandbox error. Do not change global security settings to run it. If only FUSE is missing, AppImage's `--appimage-extract-and-run` can be used instead.

## Behavior and limits

- Alt + left drag opens the ping wheel; Ctrl + left drag opens emotes. Ctrl + Alt + P pauses/resumes. Side buttons and custom keyboard triggers are supported. Escape and right click cancel an active wheel.
- A custom keyboard trigger still types when tapped: its key is held back and typed when it comes up, unless a drag used it. Pressing another key while it is held types it first.
- A short trigger + click is replayed to the underlying application unless click-to-ping is enabled. Normal clicks are replayed by the X server itself.
- Window managers may already own a chord, particularly Alt + drag or Super. The helper logs conflicting grabs. Choose a different trigger, such as Ctrl, Shift or a side button, or change the conflicting desktop shortcut.
- Caps Lock is not offered: passive X11 grabs cannot reliably prevent its lock state from changing. Automatic fullscreen-game detection is Windows-only; pause manually before games.
- Linux forces Electron to a scale factor of 1, matching X11 root coordinates. This keeps overlay placement consistent across monitors, but the settings window does not follow desktop HiDPI scaling.
- Autostart uses `$XDG_CONFIG_HOME/autostart/lolPing.desktop` (normally `~/.config/autostart/`). AppImages use the original AppImage path rather than their temporary mount. Move the AppImage before enabling autostart.
- Settings are in `$XDG_CONFIG_HOME/lolPing/settings.json` (normally `~/.config/lolPing/settings.json`).
- Updates are manual for this port. It never calls the Windows installer updater or offers an upstream package for another platform.
- Room networking, assets, audio and renderer behavior use the existing shared implementation. Public relay availability is independent of Linux support.

## Validation

```sh
sudo apt-get install xvfb
npm run typecheck
npm run test:helper
npm test
npm run test:linux-input
npm run dist:linux
```

`test:linux-input` starts its own private Xvfb display, creates a receiving application window, and sends XTest input through the actual helper. It checks ordinary click delivery, short-click replay, modifier-first release, both wheels, custom/side-button triggers, cancellation, toggle/pause, key-capture suspension, cleanup and unsupported sessions. It never injects input into the user's desktop. `XVFB` can override the Xvfb binary path.

The Linux CI job builds both packages and uploads them as workflow artifacts. Publishing a GitHub release also builds and attaches the AppImage and Debian package before the release is made public again.
