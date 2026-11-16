# Linux (experimental)

lolPing runs on Linux x64 in X11 and Wayland sessions. X11 uses XInput 2 and XTest. Wayland uses an input helper that reads `/dev/input` and passes your input on through `/dev/uinput`. The backend is chosen automatically.

## Requirements

- x86-64 Linux; development and package validation use Ubuntu 24.04.
- An X11 or Wayland desktop session, with a compositor for transparent overlays.
- X11: XInput 2.1, XTest, and the usual Electron desktop libraries. No root privileges or access to `/dev/input` are needed.
- Wayland: access to `/dev/input/event*` and `/dev/uinput` (see below). The overlays and the settings window run under XWayland, which Wayland desktops start on demand.
- GNOME needs its AppIndicator extension to display the tray. Ubuntu normally includes this extension. Other desktops need a system tray.

## Wayland input access

Wayland doesn't let an app watch or block input in other windows, so lolPing's helper does it one level down. It reads your keyboard and mouse from `/dev/input`, holds them while it runs, and replays everything that isn't a wheel gesture through a virtual device made with `/dev/uinput`. It reads this input only on your computer, only to see wheel gestures, and nothing leaves the computer.

- **.deb:** the package sets this up when it installs. The bundled helper gets the `input` group (setgid) and `/dev/uinput` is opened to that group. Removing the package takes the uinput rule back out.
- **AppImage:** the first time, the settings window shows **Set up**. It runs `pkexec` on `linux-input-setup.sh` (you enter your password once), which installs a udev rule that gives the logged-in user access to the input devices and `/dev/uinput`, and loads the `uinput` module at boot. The card also shows the same command for a terminal. Afterwards lolPing starts the helper again by itself.
- If lolPing is not working after the setup, log out and in once so the new rules apply to your session.

While the helper holds a device, other apps can't see it directly. If another tool such as `keyd` has already grabbed a device, lolPing reads the output of that tool instead.

### Limits on Wayland

- Touchpads, drawing tablets and touchscreens are not grabbed, so they don't start a wheel. Use a mouse.
- Remote desktop and screen-sharing sessions that inject their own input are not covered.
- Flatpak and Snap builds are not supported: their sandboxes block `/dev/input`.
- Wayland doesn't tell apps where the cursor is. While a gesture is open the overlays take mouse events (never longer than 10 seconds) to read the pointer position. Until they get one, the wheel follows the mouse movement the helper counts, which can drift a little from the drawn cursor.

### Developer switches

- `LOLPING_INPUT=evdev` or `LOLPING_INPUT=x11` forces a backend.
- `LOLPING_ALLOW_XWAYLAND=1` keeps the X11 backend inside a Wayland session, which only sees input going to XWayland windows. Only for testing.

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
sudo apt install ./release/lolPing-<version>-amd64.deb

# Portable build (requires FUSE support and Electron sandbox support on the host)
chmod +x release/lolPing-<version>-x86_64.AppImage
./release/lolPing-<version>-x86_64.AppImage
```

On Ubuntu versions that restrict unprivileged user namespaces, prefer the installed `.deb` if the portable build reports a Chromium sandbox error. Do not change global security settings to run it. If only FUSE is missing, AppImage's `--appimage-extract-and-run` can be used instead.

## Behavior and limits

- Alt + left drag opens the ping wheel; Ctrl + left drag opens emotes. Ctrl + Alt + P pauses/resumes. Side buttons and custom keyboard triggers are supported. Escape and right click cancel an active wheel.
- A custom keyboard trigger still types when tapped: its key is held back and typed when it comes up, unless a drag used it. Pressing another key while it is held types it first.
- A short trigger + click is replayed to the underlying application unless click-to-ping is enabled. Normal clicks are replayed by the X server itself.
- Window managers may already own a chord, particularly Alt + drag or Super. The helper logs conflicting grabs. Choose a different trigger, such as Ctrl, Shift or a side button, or change the conflicting desktop shortcut.
- Caps Lock is not offered: passive X11 grabs cannot reliably prevent its lock state from changing. Automatic fullscreen-game detection is Windows-only; pause manually before games.
- Linux forces Electron onto the X11 Ozone platform (`--ozone-platform=x11`) and a scale factor of 1 (`--force-device-scale-factor=1`), matching X11 root coordinates. Packaged desktop entries include these flags and direct launches under `WAYLAND_DISPLAY` re-exec with them before Chromium initializes Ozone, so the main and GPU processes stay on X11. This keeps overlay placement consistent across monitors, but the settings window does not follow desktop HiDPI scaling.
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

The Linux CI job builds both packages and uploads them as workflow artifacts. Release publication is unchanged; this port does not publish packages automatically.
