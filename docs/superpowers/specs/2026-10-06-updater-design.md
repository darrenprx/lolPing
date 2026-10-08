# Update checker — Design Spec

**Date:** 2026-10-06
**Status:** Approved in brainstorming; not yet implemented
**Target:** v0.5.0, released together with emotes M1 ([2026-10-06-emotes-design.md](2026-10-06-emotes-design.md))

## 1. Purpose

Keep people on the latest lolPing without visiting GitHub. lolPing checks for new releases, tells you once, and updates when you click.

**Success criteria:**
1. When a new release is out, a running lolPing notices within 6 hours (or at once on **Check for updates**) and tells you once.
2. Nothing downloads until you click **Update**.
3. On Windows one click downloads, verifies, installs silently into the same folder and relaunches, keeping settings and launch-at-startup.
4. On a Mac one click downloads and verifies the DMG, explains the last two steps, opens it and quits.
5. With **Check for updates automatically** off, lolPing never contacts GitHub on its own.

## 2. Decisions log

| Topic | Decision |
|---|---|
| How automatic | **Ask before downloading.** Checks are automatic. Downloading and installing start only from a click. |
| Windows engine | **electron-updater** with `autoDownload` and `autoInstallOnAppQuit` off, GitHub provider (`latest.yml`), SHA-512 verified, blockmap downloads of only the changed blocks, silent NSIS install. The installer isn't code-signed, so there's no signature check. |
| Mac engine | A small custom checker. Squirrel.Mac needs a paid Developer ID signature, which lolPing doesn't have. The checker uses GitHub's `releases/latest` API and verifies the DMG against GitHub's SHA-256 asset digest. |
| Mac install | Download, verify, explain, open the DMG, quit. You drag lolPing into Applications. lolPing never replaces itself. |
| Schedule | 10 s after launch, then every 6 h. |
| Notice | One toast per new version, plus a tray item and an About card until updated. |
| First version | v0.5.0 is the first with an updater. v0.4 users update by hand once. |

## 3. Architecture

```
main process
 └─ Updater ─────────── schedule, state, notify-once; renders nothing
      └─ UpdateBackend   check() / download(onProgress) / install()
           ├─ WinBackend  electron-updater
           └─ MacBackend  GitHub API + fetch + SHA-256 + shell.openPath
tray, settings (About card), overlay toast  ←  UpdateState
```

### 3.1 New modules

| Module | Kind | Responsibility |
|---|---|---|
| `src/shared/update.ts` | pure | `UpdateState`, `isNewer(candidate, current)` for MacBackend (numeric `x.y.z` only; anything else is never newer). |
| `src/main/updater.ts` | logic | `Updater`: schedule (injected timers and clock), state transitions, notify-once against `updateNotifiedVersion`, IPC handlers. Emits `'state'`. |
| `src/main/updateWin.ts` | electron-updater | `WinBackend`. |
| `src/main/updateMac.ts` | fetch, fs | `MacBackend`. Fetch, file system, `shell.openPath` and the dialog are injected for tests. |

### 3.2 Changed modules

| Module | Change |
|---|---|
| `src/shared/settings.ts` | `autoUpdateCheck: boolean` (default `true`), `updateNotifiedVersion: string \| null` (default `null`). |
| `src/shared/ipc.ts` | `SettingsApi`: `getUpdate()`, `onUpdate(cb)`, `checkForUpdates()`, `startUpdate()`, `openReleasePage()`. |
| `src/main/index.ts` | Creates the Updater with the right backend, only when packaged or when `LOLPING_UPDATE_TEST_URL` is set. Exposes the graceful-shutdown routine for `install()`. |
| `src/main/tray.ts` | Update items (§4.3). |
| `src/renderer/settings/components/AboutSection.tsx` | Update card and **Check for updates** button (§4.4). |
| `src/renderer/settings/App.tsx` | **Check for updates automatically** switch in the App section. |
| `src/shared/i18n.ts` | Strings (§4.5), English and 简体中文. |
| `package.json` | `electron-updater` in `devDependencies` (bundled into `out/main` by electron-vite, like `@noble/secp256k1`). `build.publish: [{ "provider": "github", "owner": "darrenprx", "repo": "lolPing" }]`, which makes electron-builder embed `app-update.yml` and write `release/latest.yml`. |
| `.github/workflows/release.yml` | The Windows job also uploads `release/latest.yml` and `release/lolPing-Setup-<v>.exe.blockmap`. |

## 4. Behaviour

### 4.1 State

```ts
type UpdateState =
  | { phase: 'idle'; lastCheck: number | null }
  | { phase: 'checking'; manual: boolean }
  | { phase: 'available'; version: string; notesUrl: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'installing'; version: string }
  | { phase: 'error'; message: string; retry: 'check' | 'download' };
```

- `checking` → `available` or `idle`. A failed **automatic** check goes back to `idle` silently. A failed **manual** check → `error` (`retry: 'check'`).
- `available` → `downloading` only from `startUpdate()`.
- `downloading` → `installing`, or `error` (`retry: 'download'`).
- A check while downloading or installing is ignored.

### 4.2 Checks

- **Automatic:** 10 s after launch, then every 6 h, while `autoUpdateCheck` is on. Turning it on starts the schedule. Turning it off stops it.
- **Manual:** **Check for updates** in About and in the tray always runs.
- **Notify once:** when a check finds version V newer than the running one, and V ≠ `updateNotifiedVersion`, the overlay shows one toast and `updateNotifiedVersion` is set to V.

### 4.3 Tray

| State | Item (near the top) |
|---|---|
| `available` | **Update to {v}…**: starts the update. |
| `downloading` | **Downloading update… {n}%**, disabled. |
| `installing` | **Installing update…**, disabled. |
| otherwise | **Check for updates** |

The tray has no card, so its items report how they ended with a toast: **Check for updates** shows `upToDate` when nothing is newer and the error message when the check failed; **Update to {v}…** shows the error message when the download or install failed (`updateErrorToastTitle` is the title of the error toasts). A check that finds an update shows nothing extra: the new-version toast and the menu item say so. The Settings buttons show their result on the About card instead.

### 4.4 Settings → About

- **Always shown:** the version row, with a **Check for updates** button, and a "Checked {time}" note when known.
- **`available`:** a card reading "lolPing {v} is available", with **Update** and **What's new**. **What's new** opens `notesUrl`, the GitHub release page.
- **`downloading`:** a progress bar.
- **`error`:** the message and **Retry**.
- **Mac, before the first click:** the card also says what will happen: download, open, drag to Applications, allow Accessibility again.

### 4.5 Strings (en / zh-CN)

`updateAvailable(v)`, `updateNow`, `whatsNew`, `checkForUpdates`, `checking`, `checkedAt(time)`, `upToDate`, `downloadingUpdate(n)`, `installingUpdate`, `updateToastTitle`, `updateErrorToastTitle`, `updateToastBody(v)`, `restartingToUpdate`, `updateMacSteps`, `updateMacDialog`, `updateErrCheck(reason)`, `updateErrDownload`, `updateErrDamaged`, `updateErrInstall`, `retry`, `autoUpdateCheck`, `autoUpdateCheckDesc`, `trayUpdateTo(v)`, `trayCheckForUpdates`, `trayDownloading(n)`, `trayInstalling`.

## 5. Backends

### 5.1 WinBackend (electron-updater)

- **Setup:** `autoUpdater.autoDownload = false`, `autoInstallOnAppQuit = false`, logger → lolPing's log.
- **`check()`:** `autoUpdater.checkForUpdates()`. Returns `{ version, notesUrl }` when electron-updater reports `isUpdateAvailable`, otherwise `null`. Its own semver comparison is used here; `isNewer` is the Mac's. `notesUrl` = `https://github.com/darrenprx/lolPing/releases/tag/v{version}`.
- **`download(onProgress)`:** `autoUpdater.downloadUpdate()`, mapping `download-progress` to `percent`. electron-updater verifies the SHA-512 from `latest.yml`, and deletes the file on a mismatch.
- **`install()`:**
  1. Show the toast "Restarting to update…".
  2. Run lolPing's graceful shutdown: room bye, helper stop, settings flush.
  3. Wait 1.5 s for the toast to be painted (the quit destroys the overlays). If the app is already quitting by then, stop here: the installer must not start behind the shutdown. Otherwise call `autoUpdater.quitAndInstall(true, true)`: a silent install into the existing folder (electron-builder's NSIS `--updated` path, which keeps launch-at-startup through `customUnInstall`'s `isUpdated` guard), then relaunch. A per-machine install gets the admin prompt from electron-updater's elevation helper.
- **Test override:** with `LOLPING_UPDATE_TEST_URL`, `setFeedURL({ provider: 'generic', url })` and `forceDevUpdateConfig = true`.

### 5.2 MacBackend

- **`check()`:**
  - Request: `GET https://api.github.com/repos/darrenprx/lolPing/releases/latest` with `User-Agent: lolPing/{version}` and `Accept: application/vnd.github+json`, with a 15 s timeout.
  - Reads `tag_name` (must be `v` + `x.y.z`), `html_url` and `assets`.
  - Picks the asset named `lolPing-{x.y.z}-arm64.dmg`.
  - Returns `{ version, notesUrl: html_url }` when newer, otherwise `null`. A release missing the DMG asset counts as no update.
- **`download(onProgress)`:**
  1. Requires the asset's `digest` to be `sha256:<64 hex>`. With no digest, it fails with `updateErrDamaged`, leaving **What's new** for a manual download.
  2. Streams `browser_download_url` to `<Downloads>/lolPing-{v}-arm64.dmg.part`, hashing as it goes, and reports percent from `Content-Length` or `size`.
  3. On a match, renames to `.dmg`, replacing an older file of the same name. On a mismatch or failure, deletes the `.part`.
- **`install()`:**
  1. `app.focus({ steal: true })`: lolPing is a menu bar app and not the active one, so without this the dialog can open behind other windows.
  2. A dialog, unparented: "Drag lolPing into Applications and choose Replace. Then open it and allow Accessibility again. lolPing will quit now." with **OK**. It comes before the image opens: `shell.openPath` brings Finder and the mounted image to the front, and a dialog shown after that from the background could stay hidden, with the user left to replace the app that is still running.
  3. `shell.openPath(dmg)`. A non-empty result is an error: the install fails (the update card shows it with **Retry**) and the app does not quit.
  4. Graceful shutdown, then `app.quit()`.

  The DMG is written by lolPing rather than a browser, so it isn't quarantined, and the new app opens without the "Open Anyway" steps. The existing permission card guides the Accessibility re-grant.
- **Test override:** with `LOLPING_UPDATE_TEST_URL`, the releases JSON is fetched from `{url}/releases/latest` instead.

## 6. Privacy

Checking contacts GitHub (`api.github.com` on a Mac; `github.com` and its release download hosts on Windows), which sees your IP address and lolPing's version. Nothing else is sent. With **Check for updates automatically** off, that happens only when you click **Check for updates** or **Update**.

## 7. Failure handling

| Situation | Behaviour |
|---|---|
| Offline, GitHub down, rate-limited (HTTP 403/429) or a timeout | An automatic check stays quiet and tries again at the next interval. A manual check shows `updateErrCheck(reason)` with **Retry**. |
| Download fails or is interrupted | `updateErrDownload` with **Retry**. The partial file is deleted. |
| Hash or digest mismatch, or no digest (Mac) | `updateErrDamaged`. File deleted. |
| Installer can't start (Windows) | `updateErrInstall`. lolPing keeps running, and **What's new** links to the release for a manual download. |
| Downloads folder not writable, disk full | `updateErrDownload` with the reason, and **Retry**. |
| A newer release appears while one is downloading | Ignored until the next check after this update. |
| Dev build without the test URL | The Updater isn't created; About shows no update controls. |

## 8. README (both languages)

- A new **Updates** section: lolPing checks GitHub for new versions every few hours and asks before downloading. On Windows, one click installs and restarts. On a Mac, it downloads and opens the DMG, then you drag it into Applications and allow Accessibility again. Turn checks off in Settings, and note what GitHub sees.
- A line under Install: "Updating from v0.4 or earlier: download the new version by hand once. From v0.5 on, lolPing updates itself."
- The **Releasing** note: the Windows job now also uploads `latest.yml` and the `.blockmap`, and electron-updater needs both.

## 9. Testing

**Unit (vitest):**
- `isNewer`: equal, patch, minor, major, pre-release, malformed.
- Updater schedule with fake timers: 10 s first check, 6 h interval, switching off and on.
- Notify-once, including across a restart (`updateNotifiedVersion`).
- State transitions with a fake backend: manual vs automatic failure, checks ignored while downloading, retry paths.
- MacBackend:
  - parsing a recorded `releases/latest` response
  - asset selection
  - a missing DMG asset
  - the no-digest refusal
  - digest match and mismatch (a fake fetch stream)
  - `.part` cleanup
  - the `openPath` and dialog calls (stubbed)

**Windows end to end** (`LOLPING_UPDATE_TEST_URL` → a local static server):
1. Build two local installers from the same commit, versioned `0.5.0` and `0.5.1` (bumped locally and never published). The test server serves `latest.yml`, the exe and the blockmap of `0.5.1`.
2. Install `0.5.0`, launch it with `LOLPING_UPDATE_TEST_URL` set, check, and click **Update**.
3. Confirm: progress, a silent install into the same folder, relaunch as `0.5.1`, settings kept, launch-at-startup kept, and the room rejoined when "rejoin last room" is on.
4. Repeat with the installer's custom install folder option.

**Mac** (macOS CI runner, or by hand): MacBackend against a local fake API serving a small DMG and its digest. The real check is the first v0.5.0 → v0.5.1 update on a Mac.

**Release check:** after tagging v0.5.0, confirm that `latest.yml` and the blockmap are attached to the release and that `latest.yml` names `lolPing-Setup-0.5.0.exe`.

## 10. Delivery → v0.5.0

1. `update.ts`, Updater with fake-backend tests.
2. MacBackend with tests.
3. WinBackend, packaging (`publish`, bundling electron-updater), release workflow uploads.
4. Tray, About card, App switch, toast, strings.
5. Windows end-to-end test with two test builds; Mac fake-API test.
6. README (both languages).

## 11. Out of scope

- Mac auto-replace (Squirrel.Mac or a custom swap script).
- Code signing.
- Beta / pre-release channels.
- Automatic installs without a click.
- Release notes rendered inside the app (**What's new** opens GitHub).
- Updating the hook helper separately (it ships inside the app).
