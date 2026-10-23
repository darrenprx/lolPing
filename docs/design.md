# lolPing — Design Spec

**Date:** 2026-10-01
**Status:** Implemented in v0.1.0; wheel customization (Bait, Vision Cleared, drag-and-drop slots) added in v0.2.1; rooms over LAN added in v0.3.0 (§12); emotes added in v0.5.0 (§13); foreign-chord pass-through and the fullscreen pause added in v0.5.1; custom emote stills travelling between room members, emote effects, signed room messages, room text, votes and the room panel (§14), feature switches (§15) and experimental Linux X11 support added in v0.5.2; League's normal ping colours instead of the colourblind set, overlays that follow a game's display mode change, and Windows 10 before 1703 in v0.5.3

## 1. Purpose

A personal desktop toy for Windows that recreates League of Legends' ping wheel anywhere on the desktop. Hold the trigger key (Alt by default), drag, and a League-style ping wheel opens. Release on a slice to drop that ping, with its animation and its original sound, at the point where the wheel opened.

- **Audience:** a single user on their own machine. Since v0.3.0, users on the same network can also join a room and see each other's pings (§12).
- **Capture:** pings must appear in whole-screen capture (Discord "Screen", OBS Display Capture, screenshots). Single-window capture is not supported.
- **Success criteria:**
  1. Alt+drag opens the wheel over any normal app without that app receiving the drag.
  2. Releasing on a slice shows the ping with animation and sound with no noticeable delay.
  3. With the option off, Alt+click behaves as it did without lolPing.
  4. A hotkey turns everything on and off.
  5. The settings UI follows Fluent design.

## 2. Decisions log

| Topic | Decision |
|---|---|
| Platform | Windows 11 only, multi-monitor, mixed DPI (user has two displays) |
| Stack | Electron (TypeScript) + React + Fluent UI React v9 for the UI. A small native C++ helper handles global input. |
| Default trigger | Hold **Alt** and drag with the left mouse button to open the wheel. |
| Trigger + click (no drag) | Configurable, **off** by default. Off: the click passes through untouched. On: it places a **generic** ping and the click is swallowed. |
| Toggle | A global hotkey (default **Ctrl+Alt+P**) turns pinging on/off, mirrored in the tray. |
| Wheel slots | 8 slices, top then clockwise. Default: Danger, Push, On My Way, All In, Assist Me, Need Vision, Enemy Missing, Enemy Vision. The user can drag any of the 11 pings onto any slot, and pick the trigger+click ping (default Generic), in settings. |
| Excluded pings | Defend/Hold, Target, the yellow "caution" circle: they need a target, so they wait until lolPing can pick one |
| Textures | Only standard textures. **Never colourblind (`_cb`) variants.** |
| Sound | Original League sounds, extracted from the user's local install |

## 3. Assets

The assets are already extracted into the repo and ship with the app. They come from the user's local League install and are © Riot Games. The project will be published on GitHub with the assets bundled; the owner accepts the risk and will take it down if Riot asks.

### 3.1 Ping table (single source of truth: `src/shared/pings.ts`)

Slot is the default layout (`DEFAULT_WHEEL`); the user can rearrange it.

| id | Slot | Wheel icon (`assets/textures/`) | On-screen art | Sound (`assets/sounds/`) | Ring colour |
|---|---|---|---|---|---|
| `danger` | N | `pingwheel_retreatrender.png` | `pingwheel_retreatrender.png` | `SRP_12.wav` | `#ff3b55` |
| `push` | NE | `pingwheel_pushrender.png` | `pingwheel_pushrender.png` | `SRP_9.wav` | `#35d27a` |
| `omw` | E | `omw_cyan.png` | `omw_cyan.png` (the upright `omw`, which is colourblind blue, recoloured to cyan by `--derived` with the shift between `pingwheel_omw_cb` and `pingwheel_omw`; League's only normal-colour On My Way is that flat ground render) | `OnMyWay.wav` | `#2e8bff` |
| `allin` | SE | `png_all_in.png` | `pingwheel_allin_render_01.png` + `_02.png` (two halves that clash together) | `SRP_4.wav` | `#f2b320` |
| `assist` | S | `png_assist_me_128x128.png` | `png_assist_me_128x128.png` | `ComeHere.wav` | `#35d27a` |
| `needvision` | SW | `mt11_18_vision.png` | `mt11_18_vision.png` | `SRP_7.wav` | `#35d27a` |
| `missing` | W | `png_enemymissing_128x128.png` | `png_enemymissing_128x128.png` | `MIA.wav` | `#f2c518` |
| `enemyvision` | NW | `pingwheel_enemyvisionrender.png` | `pingwheel_enemyvisionrender.png` | `AreaIsWarded.wav` | `#ff3b55` |
| `generic` | (trigger+click) | `pingwheel_basicpingrender.png` | `pingwheel_basicpingrender.png` | `Base.wav` | `#2e8bff` |
| `bait` | — | `pingwheel_baitrender.png` | `pingwheel_baitrender.png` (the hook; also used as the icon) | `SRP_11.wav` | `#efbc12` |
| `visioncleared` | — | `pingwheel_visionclearedrender.png` | `pingwheel_visionclearedrender.png` | `SRP_6.wav` | `#2b80ff` |
| `missingflip` | — | `enemy_missing_flipped.png` | `enemy_missing_flipped.png` (`png_enemymissing_128x128` turned 180°, made by `--derived`; not a League ping) | `MIA.wav` | `#f2c518` |
| wheel tick | — | — | — | `button.wav` | — |

The 128 px icons from League's `PingUpdate/Need/` folder are the colourblind set: lime instead of teal, lemon instead of gold, blue instead of cyan, pink instead of red (#83). The wheel uses the `pingwheel_*` renders where League has them, and the same icons in normal colours from `PNG/` and `MT11-18/` otherwise. `generic_ping.png` stays as lolPing's own logo (tray, toasts, settings, site).

Unused extracted files stay in `assets/` but are never referenced: the `_cb` textures and the other `Need/` icons (`all_in`, `assist_me`, `need_vision`, `enemy_missing`, `enemy_vision`, `omw`, `push`, `vision_cleared`, `caution`, `hold_ig`, `target`), the `pingwheel_*` renders not listed above, and the other sounds (`SRP_13.wav` is the structure-defend ping).

### 3.2 Asset pipeline (already run; kept reproducible)

The extraction scripts live in `tools/extract-assets/`, together with a README. Each step:

1. **Textures:** DDS (DXT5) → PNG with Pillow. Bait and Vision Cleared come straight from League's `.tex` files in `Global.wad.client` (`--wad-textures`).
   No game file maps those two pings to their sounds; `SRP_11` (Bait) and `SRP_6` (Vision Cleared) were identified by ear.
2. **Sound banks:** read the WAD v3 table of contents with a small Python reader (Python 3.14 has built-in zstd). Names come from CommunityDragon's `hashes.game.txt` list, filtered to sound banks. The ping banks are in `DATA/FINAL/Maps/Shipping/Common.wad.client`:
   - `assets/sounds/wwise2016/sfx/shared/hud_global_events.bnk`
   - `assets/sounds/wwise2016/sfx/shared/hud_global_audio.bnk`
3. **Event → clip mapping:**
   - Event names (`Play_sfx_hud_base_Pings_*`) come from string search in the game's `.bin` files.
   - The bank's HIRC section is walked from event → action → layer container → sound → embedded WEM id.
   - The event id is the FNV-1 32-bit hash of the lower-cased event name.
4. **Decoding:** the clips are Wwise Vorbis (`0xFFFF`), decoded with `vgmstream-cli` (r2117).
5. **Mixing:** layer containers play their children at the same time. They are mixed with ffmpeg `amix` plus `alimiter` (limit −1 dB) to avoid clipping. Each file has at most 35 ms of silence at the start.

## 4. Architecture

```
┌──────────────────────────── Electron app ────────────────────────────┐
│ main process                                                         │
│  ├─ InputBridge     spawns/supervises hook-helper.exe, JSON lines    │
│  ├─ OverlayManager  one transparent overlay window per display       │
│  ├─ SettingsStore   %APPDATA%\lolPing\settings.json, pushes changes  │
│  ├─ Tray            enable/disable, settings, quit, status icon      │
│  └─ SettingsWindow  React + Fluent UI v9, Mica backdrop              │
│ overlay renderer (per display): wheel + ping animations + Web Audio  │
└───────────────▲──────────────────────────────────────────────────────┘
                │ stdin: config/commands   stdout: input events (JSON lines)
┌───────────────┴───────────────┐
│ hook-helper.exe (C++ / Win32) │  WH_MOUSE_LL + WH_KEYBOARD_LL on a
│ no runtime deps, per-monitor  │  dedicated thread with its own message
│ DPI aware v2                  │  loop; decides pass-through vs swallow
└───────────────────────────────┘
```

**Why a separate helper process:**
- Only a low-level hook can swallow the Alt+drag so the app underneath doesn't drag or select text. Node global-hook libraries can only listen.
- Windows silently removes a low-level hook that responds slowly, so it can't live on Electron's busy main thread.
- A tiny dedicated process responds in microseconds and is isolated from renderer and GC pauses.

The helper looks up `SetProcessDpiAwarenessContext` at run time and falls back to per-monitor v1 (`SetProcessDpiAwareness`) when it is missing. Windows 10 before 1703 doesn't have it, and a direct import kept the helper from starting there at all (#66). Every other function it imports exists since Windows 7.

### 4.1 Repository layout

```
lolPing/
  package.json                 electron-vite + electron-builder
  electron.vite.config.ts
  src/
    main/                      index.ts, inputBridge.ts, restartPolicy.ts, overlayManager.ts,
                               settingsStore.ts, settingsIpc.ts, settingsWindow.ts, tray.ts,
                               coords.ts, paths.ts, appProtocol.ts, safePath.ts
    preload/                   overlay.ts, settings.ts  (contextBridge APIs)
    renderer/
      overlay/                 index.html, main.ts, wheel.ts, pingFx.ts, soundBank.ts, toast.ts, overlay.css
      settings/                index.html, App.tsx, useAppState.ts, components/ (Fluent UI)
    shared/                    pings.ts, settings.ts (schema + defaults), keys.ts,
                               protocol.ts (helper messages), ipc.ts, geometry.ts
  native/hook-helper/          build.cmd (MSVC via vswhere), build.sh (macOS), run.mjs, src/ main_win.cpp,
                               hooks_win.cpp, simulate.cpp, decision.{h,cpp} (pure logic), commands, json, output,
                               macOS: main_posix.cpp, hooks_mac.cpp, macinput.{h,cpp}; tests/
  assets/textures, assets/sounds
  tools/extract-assets/
  prototype/                   throwaway demos (wheel-demo.html, settings-demo.html)
  docs/design.md               this document
```

## 5. Hook helper

### 5.1 Input decision logic (pure, unit-tested state machine in `decision.cpp`)

States: `Idle`, `Pending` (trigger held + button down, not yet moved past the threshold), `Wheel` (wheel open).

| Situation | Action |
|---|---|
| Disabled | Pass everything through; only the toggle hotkey is checked |
| Mouse down that would start a gesture, `gameCheck` on and the foreground window fullscreen on the clicked monitor (its rect contains the monitor; where the monitor reserves no work area, only caption-less windows count; desktop and taskbar excluded; Windows only) | Pass through; the fullscreen app keeps every click |
| Left button down while trigger held | **Swallow**, record the point, go to `Pending` |
| `Pending`, movement > `dragThresholdPx` | Send `wheelOpen{x,y}` with the *press* point, go to `Wheel` |
| `Wheel`, mouse move | Send `wheelMove{x,y}`. Movement is not swallowed, so the cursor still moves. |
| `Wheel`, left button up | **Swallow**, send `wheelRelease{x,y}`, go to `Idle` |
| `Pending`, left button up (trigger+click) | Option on: **swallow**, send `click{x,y}`. Option off: **replay** the down+up with `SendInput` (flagged as injected so the helper ignores its own events). Back to `Idle`. |
| `Wheel`, right button down or Esc | **Swallow**, send `cancel`, go to `Idle` |
| Trigger released during `Pending` | Treat as a plain click: replay it (or ping, if the option is on) |
| Trigger released during `Wheel` | Nothing: the wheel stays open and the button up picks the slice, as in League. A trackpad's three-finger drag sends that up about a second late. |
| Toggle hotkey | **Swallow**, flip enabled, send `toggled{enabled}`. If disabled mid-drag, also send `cancel`. |
| Watchdog: no mouse event for 10 s while in `Wheel` or `Pending` | Send `cancel`, go to `Idle` |

**Invariant:** for every swallowed button down, the paired up is also swallowed, or both are replayed. An app never sees an unmatched press.

### 5.2 Modifier side effects

- **Alt / Win menu activation.** Windows opens the menu bar (Alt) or Start menu (Win) when the key goes up without any other key in between. When a wheel or ping happened while the modifier was held, the helper injects a no-op "mask" key (`VK_NONAME`, 0xFC) before the modifier's key-up. AutoHotkey uses the same trick.
- **Caps Lock as trigger:** its down/up is swallowed, so Caps state doesn't change.
- **A custom key as trigger:** its down is held back. If a drag uses it, nothing is typed. A lone tap is replayed (down + up) when the key comes up, so it still types. Another key pressed while it is held sends it first and replays that key behind it, so fast typing keeps its order. A held custom key doesn't auto-repeat until another key flushes it.
- **Mouse 4 / Mouse 5 as trigger:** the side button itself is the drag button (press side button, move, release). A side-button click without movement is replayed so browser Back/Forward still works, or it pings if the trigger+click option is on.

### 5.3 Protocol (JSON lines, defined once in `src/shared/protocol.ts`, mirrored in C++)

All coordinates are **physical screen pixels**.

- **Electron → helper (stdin):** one *flat* JSON object per line (the helper's tiny parser accepts no nesting).
  - `{"type":"config","trigger":"alt"|"ctrl"|"shift"|"win"|"capslock"|"mouse4"|"mouse5"|"vk","triggerVk":N,"clickPing":bool,"dragThresholdPx":N,"toggleMods":N,"toggleVk":N,"enabled":bool}`
    - `toggleMods` is a bitmask: Ctrl = 1, Alt = 2, Shift = 4, Win = 8. `triggerVk` is used only when `trigger` is `"vk"` (custom key).
  - `{"type":"setEnabled","enabled":bool}`
  - `{"type":"suspend","on":bool}`: while the settings window is capturing a new shortcut, pass all input through and ignore the toggle hotkey.
  - `{"type":"shutdown"}`
  - Test mode only (`hook-helper.exe --simulate`, no OS hooks): `{"type":"sim","ev":"mdown"|"mup"|"move"|"kdown"|"kup"|"tick","btn":"left"|"right"|"middle"|"x1"|"x2","x":N,"y":N,"vk":N,"t":ms,"self":bool}`. After each one the helper also prints `{"type":"sim","swallow":bool,"inject":"down:left,up:left,…"}`.
- **Helper → Electron (stdout):**
  - `{"type":"ready","version":1}`
  - `{"type":"wheelOpen","x":N,"y":N}`, `{"type":"wheelMove","x":N,"y":N}`, `{"type":"wheelRelease","x":N,"y":N}`
  - `{"type":"click","x":N,"y":N}`, `{"type":"cancel"}`, `{"type":"toggled","enabled":bool}`
  - `{"type":"error","message":"..."}`, e.g. a hotkey conflict, so the UI can report it
- **Lifetime:** if stdin closes (EOF), meaning Electron died, the helper removes its hooks and exits. The helper never outlives the app.

## 6. Electron main process

- **Single instance:** a second launch opens the settings window instead.
- **InputBridge:**
  - Spawns `hook-helper.exe` (bundled via electron-builder `extraResources`), parses its JSON lines, and sends `config` on start and on every settings change.
  - Restarts the helper with backoff (0.5 s, 1 s, 2 s). After 3 crashes within 60 s, it stops, sets the tray to a warning state and shows a toast.
- **OverlayManager:**
  - One `BrowserWindow` per display: `transparent`, `frame:false`, `focusable:false`, `skipTaskbar`, `alwaysOnTop` at level `screen-saver`, `setIgnoreMouseEvents(true)`, created with `showInactive()`.
  - On Windows the level is set again each time an overlay gets something new to draw (`wheel:open`, `ping:spawn`, `emote:spawn`, `toast:show`), never on moves. Windows 10 users saw the overlay end up behind normal windows after a while, and only a restart fixed it. Setting the level again calls `SetWindowPos(HWND_TOPMOST)` without activating, which puts the overlay back above every window, other topmost ones included. macOS is unchanged: its panel stays on top.
  - The windows cover each display's `bounds`, except that on Windows they stop one DIP short of the bottom edge. Explorer takes a shown window that covers a whole display for a full-screen app: it drops the taskbar behind it and won't slide an auto-hidden one up (`SHQueryUserNotificationState` reports `QUNS_BUSY`). Any smaller window doesn't count. The window still starts at the display's corner, so overlay coordinates don't change. They are rebuilt on `display-added`, `display-removed` and `display-metrics-changed`.
  - `display-metrics-changed` can be missed on Windows (electron/electron#3403): a game switching the desktop's display mode leaves the windows and the coordinate maps sized for the old mode, so wheels clip at the new edges or land on the wrong display. Before placing anything from screen coordinates (a wheel or a click) and before every new draw the manager raises (`ping:spawn`, `emote:spawn`, `toast:show`, `text:spawn`), it compares the displays with the last rebuild and rebuilds when they disagree. The comparison includes the scale on Windows: 4K at 200% and 1080p at 100% have the same DIP bounds but different physical pixels.
  - Each event is routed to the overlay whose display contains the press point. A wheel near a screen edge may be clipped; it is not clamped, the same as in League.
- **Coordinates:** `screen.screenToDipPoint({x,y})` converts physical pixels to DIP, then the display's DIP origin is subtracted to get overlay-local CSS pixels. Wheel moves are converted relative to the *wheel's* display, even when the cursor crosses onto another monitor.
- **Toggle feedback:** tray icon state (normal or dimmed), the tray menu checkbox, and a small Fluent toast saying "Pings on" or "Pings off".
- **Startup:** "Launch at Windows startup" uses `app.setLoginItemSettings` with the argument `--hidden`. A manual launch opens the settings window; a `--hidden` launch stays in the tray.

## 7. Overlay renderer

### 7.1 Wheel (matches the in-game reference screenshot and `prototype/wheel-demo.html`)

**Geometry:** SVG centered on the press point.

| Part | Size / style |
|---|---|
| Center disc | radius 86 px, teal radial gradient, 3 px gold ring `#c8aa6e` |
| Ring | 8 wedges from radius 86 to 188 |
| Cardinal wedges (N/E/S/W) | extend to radius 288 with a fading gradient |
| Wedge dividers | thin gold-tinted lines |

- **Slots:** each slice shows the ping from the `wheel` setting; the overlay redraws the icons when it changes.
- **Center content:** the generic-ping icon, a "PING" label in `#1fa9e0`, and a dim "BACK" hint with a right-click mouse glyph.
- **Icons:** 48 px at radius 137. Idle icons are desaturated gold (`grayscale(1) sepia(.75) saturate(1.3) brightness(1.15)`). The hovered slice shows the full-colour icon at 1.18× scale and a brightened wedge.
- **Selection:**
  - The slice is picked from the angle between the press point and the cursor, in 45° sectors centered on N, NE, …
  - A distance under 86 px means nothing is selected; releasing there cancels.
  - Moving onto a new slice plays `button.wav` at low volume, if the tick sound is enabled.
- **Animation:** opens with fade + scale 0.85 → 1 over 120 ms, closes with a fade.

### 7.2 Ping animation (as in the prototype)

The default duration is 3.2 s and scales with the "ping duration" setting. The art is drawn at "ping size" (default 110 px) and anchored so the ground ellipse sits on the press point.

1. **Pop:** scale 0.4 → 1.15 → 1.0 and fade in over 280 ms with an overshoot ease.
2. **Rings:** coloured rings expand 0.25× → 1.35× and fade over 650 ms, at 0, 220 ms and 1.4 s.
3. **Hold:** a gentle 5 px bob on a 1.6 s cycle, a coloured glow drop-shadow, and a soft coloured ground ellipse.
4. **Fade out** over the last ~13% of the duration, then the element is removed.
5. **All In:** the two halves slide in from opposite diagonals over 220 ms, then a white-to-colour flash and a 250 ms shake, then the bob.

Several pings can be on screen at once, and each is independent.

### 7.3 Audio

- **Decoding:** all ping and tick sounds are decoded once into `AudioBuffer`s at overlay load, with `AudioContext({latencyHint:'interactive'})`.
- **Playback:** each play is a fresh `AudioBufferSource` → `GainNode` (volume from settings). This removed the noticeable delay heard with `HTMLAudioElement` in the prototype.
- **Autoplay:** Electron's `autoplayPolicy: 'no-user-gesture-required'` keeps the context running without a user gesture.
- **No double sounds:** only the overlay that renders a ping plays its sound.

## 8. Settings

### 8.1 Schema (`src/shared/settings.ts`, versioned)

| Key | Type | Default |
|---|---|---|
| `version` | number | 1 |
| `enabledOnStart` | bool | true |
| `trigger` | `alt`/`ctrl`/`shift`/`win`/`capslock`/`mouse4`/`mouse5`/`{vk}` | `alt` |
| `dragThresholdPx` | 2–40 | 8 |
| `clickPing` | bool | false |
| `clickPingId` | ping id | `generic` |
| `wheel` | 8 distinct ping ids, top then clockwise | `DEFAULT_WHEEL` (an invalid list resets to it) |
| `toggleHotkey` | `{mods, vk}` | Ctrl+Alt+P |
| `wheelSizePx` | 300–900, step 10 (both wheels) | 600 |
| `pingSizePx` | 60–220 | 110 |
| `pingDurationS` | 1.0–8.0 | 3.2 |
| `keepLastPing` | bool: our newest ping (wheel or click) stays after its animation until our next ping on any display (`ping:unkeep` to the others), a pause, or the switch going off. Room pings and previews still fade. | false |
| `volume` | 0–100 | 70 |
| `muted` | bool | false |
| `tickSound` | bool | true |
| `launchAtStartup` | bool | false |
| `features` | `{emotes, rooms, roomText, roomVotes, roomPanel}` of bool; a missing or broken key falls back to on, one by one (§15) | all true |
| `textHotkey` | `{mods, vk}`, needs Ctrl, Alt or Win | Alt+T (Alt+Y when Alt+T is taken) |
| `panelKey` | one key code; modifiers, Esc and the key of another shortcut fall back to Tab | Tab (`0x09`) |
| `roomTextStyle` | `spot`/`danmaku` | `spot` |

Changes apply live, with no Save button. Writes are debounced (300 ms) and atomic (write a temp file, then rename).

### 8.2 Settings window (matches `prototype/settings-demo.html`)

- **Window:** Fluent UI React v9 components, `backgroundMaterial: 'mica'`, theme follows Windows light/dark, Windows 11 caption buttons, left navigation (Trigger, Toggle, Pings & sound, Wheel, App), Windows 11 Settings–style cards.
- **Status card:** at the top, a master on/off switch with a live hint ("Hold Alt and drag… · Ctrl + Alt + P to turn off"). Turning it off dims the dependent cards.
- **Trigger key:** a Fluent `Dropdown`, *not* a native select, with Keyboard and Mouse option groups plus "Custom key…", which captures the next key press.
- **Toggle shortcut:** a key-capture field showing keycaps. Click it, press a combination, and it rebinds; Esc cancels. A conflict reported by the helper shows inline and keeps the old binding.
- **Sliders:** drag distance, ping size, ping duration, volume. **Switches:** trigger+click ping, start enabled, tick sound, launch at startup.
- **Wheel** (matches `prototype/wheel-editor-demo.html`): a small wheel with the 8 slots and the trigger+click ping in the centre, beside a tile per ping (no `_cb` textures).
  - Clicking a tile previews it: plays its sound and spawns it at the center of the primary display.
  - Drag a tile onto a slot to put it there; a ping already on the wheel swaps places instead, so no ping appears twice. Drag a slot onto another to swap them. Drop on the centre to set the click ping.
  - Without dragging: click a tile or slot, then click where it goes. Esc cancels. "Reset to default" restores `DEFAULT_WHEEL` and Generic.
  - The rules live in `src/shared/wheelLayout.ts` as pure functions.
- **About:** version, asset notice, known limitations, asset problems, and "Open settings folder".

### 8.3 Tray

- **Left-click:** opens the settings.
- **Right-click menu:** Enabled ✓ / Settings… / Quit.
- **Icon states:** normal, dimmed (disabled), warning (helper failed).

## 9. Error handling

| Failure | Behaviour |
|---|---|
| Helper crashes or exits | Restart with backoff. After 3 in 60 s: stop, warning tray icon, toast, pinging paused until re-enabled. |
| Electron hangs or dies | The helper sees stdin EOF, unhooks and exits, so input is never left captured. |
| Stuck drag | 10 s watchdog in the helper sends `cancel`. Swallowed downs and ups are always paired. |
| Missing or undecodable sound | That ping is silent; logged and listed in About. |
| Missing texture | Fall back to `generic_ping.png`; logged and listed in About. |
| Corrupt `settings.json` | Back it up as `settings.bak.json` and use defaults. |
| Toggle hotkey conflict | Inline error in the settings; previous binding kept. |
| Display change | Overlays rebuilt; an active wheel is cancelled. |

**Known limitations** (listed in About):
- Elevated (admin) windows such as Task Manager don't receive the hook, because Windows blocks it, so the wheel can't be triggered over them.
- Exclusive-fullscreen games draw above the overlay.
- Single-window screen capture doesn't include the overlay.

## 10. Testing

- **Vitest (TypeScript):**
  - slice picking (sector boundaries at ±22.5°, dead-zone at 86 px, angle wrap)
  - coordinate conversion across two displays with different scale factors
  - settings defaults, clamping, migration, and corrupt-file fallback
  - ping table integrity: every referenced asset file exists, no `_cb` file is referenced
  - protocol message parsing
- **C++ unit tests** for `decision.cpp` (no OS hooks), as table-driven event sequences:
  - drag opens the wheel
  - click with the option on and off
  - trigger released early (before the wheel opens, and while it is open)
  - right-click / Esc cancel
  - toggle mid-drag
  - watchdog
  - mask key emitted for Alt/Win
  - injected events ignored
- **Protocol integration test:** spawn the real `hook-helper.exe` in a test mode that reads simulated input events from stdin instead of installing hooks, and assert the JSON output.
- **Manual checklist** before calling v1 done:
  - Alt+drag over Chrome, Explorer, VS Code and Discord, with no text selection or menu bar activation
  - Alt+click with the option on and off
  - toggle hotkey while idle and mid-drag
  - both monitors at their real scale factors
  - pings visible in Discord "Screen" share and OBS Display Capture
  - kill the helper → it auto-restarts
  - kill Electron → mouse and keyboard are normal

## 11. Out of scope for v1

Multiplayer/sync (rooms arrived in v0.3.0, §12), rebinding wheel slots, colourblind texture sets, per-ping volume, macOS/Linux, ping spam throttling, and a minimap.

macOS support was added in v0.2.0; see [design-macos.md](design-macos.md).

### Linux (X11, experimental)

The Linux port is an X11 backend. Setup, limits and testing are in [linux.md](linux.md). In short:

- XInput 2.1 raw events watch the keyboard. The helper does not read `/dev/input` and does not take keyboard focus.
- Passive grabs catch the wheel trigger. Normal clicks are passed on with `ReplayPointer`.
- XTest replays short trigger clicks and tapped trigger keys to the application underneath.
- Wayland sessions, including XWayland, are refused at start with a `noAccess` error.
- Electron is forced to scale factor 1 to match X11 root coordinates. There is no updater; updates are manual. Autostart uses an XDG `.desktop` file.

## 12. Rooms (v0.3.0, internet in v0.4.0)

- **Model:** a room is a code, `PING-XXXXX-XXXXX` (Crockford base32, 9 random characters + a Luhn mod 32 check character, `src/shared/roomCode.ts`). Parsing ranks candidates and never glues neighbouring words onto a code; clipboard reads are strict. Every finished ping (wheel or trigger+click, never a settings preview) goes to every member; up to 16 people, yourself included. 16 is set by relay intake: 16 senders at the relay ping cap are 80 events/s steady and 160 in a burst, under `RelayPool`'s 200/s. A larger room needs relay measurements (`tools/relay-probe`) first.
- **Crypto (`src/main/roomCrypto.ts`):** scrypt(code) → HKDF → AES-256-GCM. Each packet is `[0x01][nonce][ciphertext+tag]`, at most 1200 bytes. Keys never leave the main process.
- **Messages (`src/shared/roomProtocol.ts`):** `presence` (name, tag colour, `on`/`paused`/`muted`, protocol and app version), `ping` (ping id, display number, x/y as 0–1 fractions), `bye`; v0.5.0 adds `emote` (see §13); v0.5.2 adds `text`, `alive`, `vote` and `ballot`, and an optional `nf` field on presence (see §14). Everything is validated field by field; names are stripped of control and bidi characters and shown with `textContent`. A per-peer sequence window plus a ±10 min timestamp check rejects replays. Packets outside that window never touch the member list; they only raise a "clock more than 10 minutes off" hint.
- **Signatures (v0.5.2):** every member makes an Ed25519 key on every join (a new one each time, because a peer that said bye stays rejected for the receiver's session). Its peer ID is the first 16 hex characters of SHA-256 of the public key, presence carries the key (`pk`), and every message but a chunk is signed: the signature is appended as a last field, `,"sg":"<base64>"}`, so a receiver cuts it off and checks the exact bytes the sender encoded. An older app parses the same JSON and drops `sg` and `pk` like any unknown field, so 0.5.1 and 0.5.2 share a room with no protocol bump. A signed message counts only with the key its sender's presence proved (the ID must be the key's hash); signed and unsigned traffic have separate replay windows and "gone" lists; an unsigned packet claiming an ID a key has proved is dropped; and a signed presence takes over an ID that an unsigned packet claimed first. So nobody can send a `bye` or a high sequence number for a member on 0.5.2. Chunks stay unsigned, because a signature would push a chunk past the packet cap or need more chunks than 0.5.1 accepts; a still is checked against its hash when assembled, and a chunk never moves a replay window, liveness or a route. `tools/room-peer --legacy` acts like 0.5.1, and `--forge <id>` sends the forgeries.
- **RoomManager (`src/main/roomManager.ts`):** members, path choice (LAN while alive, else internet), the incoming rate limit (per member, user setting 1–20/s or unlimited), mute (room and per person), timeouts (LAN path alive 6 s and member dropped after 15 s; internet path alive 25 s and member dropped after 30 s, and a member dropped that way keeps its peer ID, so the same ID coming back returns quietly instead of joining again), "room is full" 3 s after the relays answer (at most 15 s). It only talks to the network through the `Transport` interface (`src/main/transport.ts`); a `shared` transport gets each packet once, pings over it are capped at 5/s (bursts of 10), and presence at once a second.
- **LAN transport (`src/main/lanTransport.ts`):** one UDP socket on port 47474. Presence is broadcast every 2 s to 255.255.255.255 and each interface's directed broadcast; pings go unicast to the address a member's packets come from. Before decryption, a flood guard allows 100 packets/s per source IP and 800/s in total, and tracks at most 1024 addresses. The socket is re-bound after sleep.
- **Mapping:** displays are numbered #1 = primary, then left→right, top→bottom (`src/main/displayNumbers.ts`). A ping lands on the receiver's display with the same number, or #1, at the same fraction of its size. `resolveTarget` is the hook a later share-window mode replaces.
- **Overlay:** wheel pings are reported back to main (`overlay:pinged`); remote pings carry a name tag. Safety ceiling: 60 pings on screen, 8 overlapping sounds.
- **Relay transport (v0.4.0, `src/main/relayTransport.ts`):** each sealed packet becomes one ephemeral Nostr event (kind 24747, tag `x` = a topic derived from the code, base64 content), signed with a key made fresh on every join (`src/main/nostrEvent.ts`), and published to every live relay in `src/main/relays.ts`. No WebRTC and no server of our own; members never see each other's IP over it.
  - `RelayPool` drops copies by event id and caps intake at 200 events/s. `RelayConnection` judges each relay by our own events coming back: no echo for 25 s means down and a reconnect with backoff (2 s → 60 s); `rate-limited` cools it for 30 s; `blocked`/`restricted`/`auth-required`/`pow`/`invalid`, a message over 64 KB or over 400 messages/s retire it for the session.
  - Status is `ok` while any relay echoes, `unavailable` after 15 s without one (the Room page then offers Retry). "Allow internet connections" off means no relay is contacted; turning it off mid-room sends no bye.
  - The relay list came from `tools/relay-probe`. Any later list must keep at least 3 of the previous one, or old and new versions can't meet. Development builds read `LOLPING_RELAYS` instead.

## 13. Emotes (v0.5.0)

A second wheel, opened by its own key, places a League emote (a short animation and a sound) the way a ping is placed, and rooms carry it like a ping.

- **Helper, two triggers:** `config` gains `emoteTrigger` (a trigger name or `"off"`), `emoteTriggerVk` and `emoteClick`, and the helper's `ready` version becomes 2. Every `wheelOpen`, `wheelMove`, `wheelRelease` and `click` event carries `wheel`: `"ping"` or `"emote"` (a missing field means `"ping"`, so an older helper still works). A press that both triggers claim, such as Alt and Ctrl held together, is ambiguous and passes through untouched. The emote key defaults to Ctrl, so Ctrl + drag no longer reaches the app underneath while lolPing is on; that is listed under known limitations in the README. It can't be the ping trigger (Caps Lock counts as one key however it was picked) or the pause shortcut's key; a settings file edited by hand into a clash turns the emote key off and shows a problem in About.
- **Settings:** `emoteTrigger` (default `ctrl`), `emoteClick` (false), `emoteWheel` (8 distinct emote refs, top then clockwise), `clickEmoteId`, `emoteSizePx` (80–300, default 150), `emoteSound` (true) and `customEmotes` (at most 24). An emote ref is a bundled slug or `c:` plus the 32 hex characters of an imported image's hash. The ping and emote wheels share one generic `WheelEditor` in the settings window.
- **Overlay:** the emote wheel is a second copy of the wheel's SVG with its own centre label. `EmoteStage` (`src/renderer/overlay/emoteStage.ts`) shows the emotes: at most one per owner (`self`, `preview` or a room member's peer ID), each for 3 s. A bundled emote's animated WebP plays once and Chromium gives images with the same URL one shared clock, so the stage fetches each file as a Blob once and gives every spawn its own object URL, revoked when the emote ends. A custom emote plays one of 6 signature CSS effects: the plain pop, a spin-in, a drop with a bounce, a flash into focus, a pendulum swing and a heartbeat. Which effect an imported emote plays is stored per image (`customEmotes[i].fx`, 0–5, the plain pop when unset) and picked by right-clicking it in the settings window's wheel editor or pool, whose grid plays every effect live on that image — the picker builds the same nodes the overlay spawns (`src/renderer/shared/emoteFx.ts`, and the shared `emoteFx.css`). Seven more effects with glow sprites around the art were tried and left out. The effect rides on the `emote` room message (`fx`, validated on receive, a malformed one dropped for the plain pop), so friends see the sender's pick even when the image is only in their cache — and it wins over the effect stored here when we happen to have the same image imported, since the moment is the sender's. An app before 0.5.2 leaves the field out and its emotes play the plain pop. A new emote from an owner replaces their old one on every display: main sends `emote:clear` to the other overlays. Main works out what an emote looks like (`resolveEmoteArt`): bundled, a custom image, or the "?" placeholder for a custom emote whose files are missing here, and the overlay trusts that.
- **`lolping://emotes/<hash>.webp`, `.anim` and `.sound`:** the custom protocol (`src/main/appProtocol.ts`) serves imported emotes from `<settings folder>/emotes`, in development too. It only answers those three names for a 32-hex hash (`.sound` is the `.sound.ogg`, `.mp3` or `.wav` on disk), never caches (an image can be removed and imported again under the same name), and gives the still when the animation is gone.
- **Imported emotes (`src/main/emoteLibrary.ts`):** the settings window turns a file into a still of at most 12,288 bytes and 160 px on its longest side (128 px as a fallback), and keeps the original GIF or WebP when it is at most 5 MB and 1024 px. Main checks it all again and names the emote by the first 32 hex characters of the SHA-256 of the still. Files are written through temporary names and renamed together, so a failed import leaves nothing behind.
- **Imported emote sounds (v0.5.2):** the speaker on one of our own image tiles gives it a sound. The settings window refuses anything but OGG, MP3 or WAV by its first bytes, over 1 MB, or longer than 5 s once decoded; main checks the type and size again (`setSound`) and writes `<hash>.sound.<type>`, deleting one in another format. The entry gets `sound: true` (`normalizeSettings` keeps the flag only when it is `true`, so older settings files read as before). `resolveEmoteArt` adds the sound URL only for our own emotes, so it plays when we place the emote or preview it, under the emote sound setting, and never for a room member's. Sounds never travel: rooms and relays carry nothing new. The overlay loads a sound on its first play and drops loaded custom sounds whenever settings change, since a sound can be replaced under the same URL.
- **Rooms (`emote` message):** same fields as a ping with an emote ref in place of the ping ID. It follows a ping's routes and checks (paused, room and member mute, update needed, display number), the same incoming limit per member, and over relays the same 5/s, burst-of-10 cap, which pings and emotes share. An unknown but well-formed ref is accepted and shows the placeholder. Members whose presence says an app older than 0.5.0 are marked "Can't see emotes, needs an update".
- **Custom stills travel (v0.5.2, `src/main/emoteTransfer.ts` and `src/main/emoteCache.ts`):** presence gains `em`, the distinct hashes on the wheel and centre, at most 9 (validated to at most 9 32-hex strings; an app before 0.5.2 just leaves the field out). A member whose announced hash is neither in the library nor the cache asks for it with `want {to, h, need}` and gets the still in `chunk {h, i, n, b}` messages: 750 bytes of base64 per chunk, at most 17 per still, each sealed packet under the 1,200-byte cap. Over LAN chunks go unicast to the requester, two per 100 ms tick and at most eight per tick across the whole room (~60 KB/s egress however many members ask); over relays they are broadcast on the ping bucket but only while five of its ten burst tokens stay, so pings keep their burst and an idle sender streams a still in a few seconds. Wants over relays follow the same rule: joining a room can find 9 hashes per member at once, and the ones without a spare token go on later ticks. want and chunk messages count against their own per-member bucket (60/s), a paused lolPing neither fetches nor serves stills, the room cap is judged on every presence (not only at settle) and one LAN address backs at most two members — a room member cannot grow the room afterwards to farm serving quota. The receiver assembles at most 16 hashes and 256 KB at once, drops an assembly after 60 s or three unanswered re-asks 3 s apart, and keeps a finished one only when it hashes back to its ID and passes the import checks (a still WebP of at most 12,288 bytes and 160 px) — the hash is the identity, so nobody can substitute another member's image, and the bytes are only ever written as `<hash>.webp` in the cache and only ever decoded by Chromium as an `<img>`. The cache (`<settings folder>/emote-cache/`) holds at most 200 stills and 4 MB, evicting least recently used; a still shown on screen counts as used. Its index is read once at launch, which also clears temp files a crashed write left, so a put never lists the folder. Everything is sealed with the room key like every room message. **Show friends' custom emotes** (Settings → Room, `friendEmotes`, default on) stops both directions at once: no wants sent or answered, no chunks taken, pending work dropped, and friends' images show as the placeholder, cached ones included. Animations never travel.
- **Known limitation:** since 0.5.2 members sign their messages (§12), so a member can't forge another's `bye` or sequence number. A member still on 0.5.1 signs nothing, so another member can still do that to them until they update. Names are free text: anyone can pick a name someone else uses.
- **Baker:** `tools/extract-assets/emote_bake.py` (run with `--emotes`) reads League's emote effect files and bakes each emote at 30 fps on a 320 × 320 canvas holding 256 px of art, as a 3 s animated WebP (quality 80, played once), with an icon PNG and an Opus `.ogg` sound at 96 kbps. It also writes `src/shared/emoteCatalog.ts`, the single list of bundled emotes, and the build leaves out any emote file that list doesn't name.

## 14. Room text, votes and the room panel (v0.5.2)

Friends in a room can type a line, vote, and see who is in the room, in the way League does. All of it travels as room messages, sealed with the room key like pings, so no new host is used.

### Messages and presence

`PROTOCOL_VERSION` stays 1. An older app drops a message type it does not know, as it did with `emote`.

- **`text`** (`text`, `d`, `x`, `y`): `UNSAFE_CHARS` are removed (this removes line breaks), the string is trimmed and cut to `MAX_TEXT` = 120 code points. A text that is empty after cleaning is rejected. `d`, `x` and `y` place it as in `ping`. A worst-case text sealed stays under the 1,200-byte packet cap; a test checks it.
- **`alive`** (`who`, `d`, `x`, `y`): `who` is a 16-hex peer id. It copies a click on a player in League's scoreboard. The receiver builds "<name> - Alive" in its own language with the name of the clicked member, and shows it like a text line with the clicker's name tag. An unknown `who` drops the message.
- **`vote`** (`id`, `kind`, `target?`): `id` is 8 lower-case hex characters, `kind` is `ff`, `ready` or `kick`. `target` is a 16-hex peer id, required for `kick` and absent otherwise.
- **`ballot`** (`id`, `yes`).
- **Presence `nf`:** the room features the sender has turned off, filtered to `text` and `votes`, duplicates dropped. A malformed `nf` is read as empty and the presence is kept.
- **Old and switched-off members:** `ROOM_CHAT_SINCE` (`0.5.2`) works like `EMOTES_SINCE`. A member on an older version is marked "can't see text and votes". A member whose `nf` lists a feature is marked "has text off" or "has votes off". The room state carries these as `noChat`, `textOff` and `votesOff`.

### Gates and limits

- `text`, `alive` and `vote` use the sender's ping bucket (relays: 5/s, bursts of 10) and the receiver's per-member incoming limit. They are dropped for a muted member or a muted room, and when the matching feature is off.
- `ballot` skips the user's incoming limit, so a low limit cannot turn a ballot into a no. It is deduplicated per member and vote id, and accepted at most once every 2 s per member.
- Text stays on screen for 4 s plus 60 ms per code point, at most 10 s, at most 3 lines per member. In the spot style it sits at the pointed spot. In the 弹幕 style it crosses the top quarter of the display at 160 px/s, in lanes. The style is the receiver's choice (`roomTextStyle`). Timing and lanes are in `src/renderer/overlay/roomTextLayout.ts`.
- The History tab keeps this session's text, alive lines and vote results, at most 200, in memory only (`src/main/roomHistory.ts`). Leaving the room clears it.
- `src/shared/textCommands.ts` reads the input box: `/ff` and `/surrender` start or join a surrender vote, `/noff` votes no, `/ready` starts a ready check. Any other text that starts with `/` is not sent and shows a hint. With votes off, the vote commands answer "votes are off".

### Votes (`src/shared/voteTally.ts`, `src/main/roomVotes.ts`)

Every member counts the ballots itself. Nobody announces a result.

- **Start:** a `vote` arrives, or we start one from the panel or a command. If one is open, the new one is dropped, and when we tried to start it we see "A vote is already running". There is no cooldown.
- **Voters** are fixed at the start: the members we see plus ourselves, without the target of a kick. Later joiners cannot vote. The starter counts as yes.
- **Ballots:** the first ballot from a voter is final. Ballots from non-voters or for another id are ignored. Our own ballot is sent again every 3 s until the vote closes, so one lost packet does not decide it.
- **Time limits** are constants of the receiver, never taken from the sender: surrender and kick 60 s, ready check 15 s. Missing ballots count as no, and so does a voter who leaves or drops.
- **Thresholds:** surrender passes at `ceil(0.7 × voters)` yes; a ready check needs every voter and fails on the first no; a kick needs `floor(voters / 2) + 1` yes with the target not counted as a voter.
- **Early end:** as soon as the result cannot change.
- **Mute and switches:** a muted member's `vote` opens nothing for us and we count as no in it; their ballots in other votes still count. With `roomVotes` off we open nothing, send no ballots, and `nf` lists `votes`, so others count us as no.
- **Kick is best effort.** When a kick passes, each member that counted it drops the target and ignores that peer id for the session. The target's own app counts the same ballots, leaves the room, clears `lastRoomCode` and says "You were removed from the room". Members whose count differs because of lost packets may still see the target, and a kicked person can rejoin by entering the room code again, which makes a new peer id. The room code is the only key, so a kick doesn't lock anyone out. Nobody can target themselves, and a kick for a peer we do not know is dropped.

### Text hotkey and panel key in the helper

- `config` gains `textMods`, `textVk` and `panelVk`. A `textVk` or `panelVk` of 0 means "not live": the helper then leaves that key to other apps. The main process sends a real code only while lolPing is on, we are in a room, and the matching feature is on (`liveKeys` in `src/shared/features.ts`).
- Events gain `{"type":"textRequested"}` and `{"type":"panel","show":bool}`. The main process reads the cursor position itself.
- **Text hotkey:** while live it is swallowed, together with its key-up, and the helper sends `textRequested`. An app's own Alt+T (the Tools menu in Firefox, the Office ribbon) and the Mac's ⌥T character do not reach it. Alt is also the default ping trigger; Alt+T is a key combination and the wheel needs the mouse, so they do not conflict. The same holds for a custom trigger key — the text branch matches its chord exactly, modifiers included, before the trigger branch sees the key — so the settings let a text chord share a custom ping or emote key (issue #100). When Alt is released after a swallowed T, the helper injects the mask key (§5.2) so Windows does not open the menu bar.
- **Panel key (default Tab):** with no modifier held, the key down is captured at once and never replayed, and the helper sends `panel {show: true}`. Its key-up sends `panel {show: false}`. Auto-repeat is swallowed. These cases pass untouched: a key down with Ctrl, Alt, Shift, Win or ⌘ held (Alt+Tab, Ctrl+Tab, Shift+Tab), a fullscreen app in front with `gameCheck` on (Windows only, so League keeps its own scoreboard), lolPing paused, and no room or the feature off.
- **Release paths:** if the configuration changes while the key is down (the room is left, lolPing is paused, the feature is turned off), the panel hides and the key-up is still swallowed, so the key never stays pressed. On Windows a watchdog hides the panel when a captured key has not repeated for 1.5 s, in case the key-up was lost. On macOS and Linux a held key does not reliably repeat, so the watchdog is off there and the panel waits for the key-up.
- **The panel key is a deliberate exception to guarantee 1 in AGENTS.md** (input passes through), chosen by the maintainer. League shows its scoreboard the moment Tab goes down. Holding the key back to see whether it is a tap, and replaying it, would delay the panel or reorder input. So the key is taken at once and not given back. The exception is as small as it can be: only while in a room, only that one key, only with no modifier, never over a fullscreen game with `gameCheck` on, and the user can change the key or turn the panel off. The Settings page, both READMEs and this section say so.

### Windows that take clicks without focus (`src/main/panelWindows.ts`)

- The roster panel and the vote widgets take clicks but not focus: `focusable: false`, shown with `showInactive()`, always on top at the level of the overlay. On macOS the window is `type: 'panel'`. They are created when needed, and each has its own preload with only what it needs.
- The text box (`src/main/textWindow.ts`) is the one new window that takes focus. It opens at the cursor, Enter sends, Esc or losing focus cancels, and focus returns to the window that had it. On macOS it is a non-activating panel.
- **Look:** League's own art in `assets/ui`, cut from the game and client files by `tools/extract-assets --ui` and drawn as CSS backgrounds and border images (`src/renderer/league.css`). Surrender and kick sit on the in-game surrender widget: a bar segment per voter in its vote slot, its cyan timer bar, then "You voted yes." The ready check follows the client's own (`rcp-fe-lol-navigation`: its sizes, its frame, the map scene masked to a circle, its Accept art): drawn at the client's 530 px and zoomed to 0.8. Its ring of light is the client's videos: the countdown, sped up or slowed down every second so it ends with the vote, as the client does; then the accepted intro followed by its idle loop, or the declined burst with the scene turned grey. The titles follow the client's: the vote's name, then "Accepted" and "Waiting for the others", or "Declined". Its sounds are the client's too, at the ping volume (none when muted): match found and the countdown when it appears, the countdown fading into the accepted loop on Accept, a fade to silence on Decline or when the vote ends without us, and an immediate stop when the card closes, since a hidden window stops the animation frames a fade would wait on. The room panel is the Tab scoreboard frame at 0.64 scale: two columns filled left first, a cell for each place in the room, the vote buttons in its header and the tabs on its cap. The text box, the text bubbles and the toasts use the edges of the in-game options window. League's fonts are not used (they are licensed from a type foundry); the closest system fonts stand in. The settings window stays Fluent.
- **Spike result:** on Windows 11 a 300 x 200 window with these settings took a scripted mouse click while Notepad stayed in front; the same window with `focusable: true` moved the foreground to itself, so the test tells the two apart. Not tried: a real borderless game and a hardware mouse. macOS and Linux are unverified. The fallback, if one OS cannot do it, is a panel that takes focus while the key is held and gives it back on release.
- The panel shows the room code and member count, one row per member (name tag, status, LAN or internet), a button to mute, a kick button (hidden on your own row and with votes off), Surrender and Ready check buttons, and a History tab. Clicking a name posts "alive", unless text is off.

## 15. Features (v0.5.2)

Each larger piece can be switched off. This keeps lolPing small for people who want only pings.

- **List:** `src/shared/features.ts`. The ids are `emotes`, `rooms`, `roomText`, `roomVotes` and `roomPanel`; the last three require `rooms`. `featureOn(settings, id)` is true only when the feature and the one it requires are on. `normalizeFeatures` repairs the `features` setting key by key, so a file from 0.5.x loads with everything on.
- **Where the switch is read:** four places. What goes to the helper (`configCommand`: no emote key when `emotes` is off, no text or panel key outside a live room); which room messages `roomManager` accepts and sends; which sections the settings window shows; and the Features page itself, which greys the children of a feature that is off.
- **What off means:** `emotes`: no emote key, no Emotes section, incoming emotes dropped. `rooms`: the Room section and the tray's room items are hidden, and the current room is left at once. `roomText`: no text shortcut, nothing sent or shown, `nf` lists `text`; the panel's alive click does nothing too. `roomVotes`: see §14. `roomPanel`: the panel key is never captured.
- **A feature is a unit:** a main-process module with its decisions in a pure module beside it (`roomText.ts`, `roomVotes.ts`, `panelWindows.ts`). This is a convention, not a plugin system: there is no loader and no registry. Existing emote and room code only got the switch at the edges above.
- **Features do not depend on League's content.** Pings, emotes and their sounds are content (`assets/`, `pings.ts`, `emotes.ts`). Rooms, text, votes and the panel are features. Their League art in `assets/ui` is decoration: every button, label and timer is our own markup, so the widgets still work with the images replaced or missing.
