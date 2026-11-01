# Performance scenarios

Run from the repository root with the Electron binary and native toolchain installed:

```sh
npm run test:helper
npm run build
npm run test:performance
```

## Output backpressure

`test:helper` builds and runs `output-scenario` against the real native `Output` queue.
The scenario blocks its writer, submits an open event, 8,000 moves, a release and a
cancel, then drains the queue. The expected output is five lines, including the
initial ready message and the latest position. Control messages and changes of
wheel identity separate move runs. Further scenarios exercise raw protocol lines,
queue capacity, repeated stop, writer failure and a replacement output instance.

Pending adjacent moves for the same wheel share one queue entry. Formatting runs
on the writer thread. A release carries its own final coordinates; the renderer
uses those coordinates to choose the action. Intermediate hover states and tick
sounds can be skipped during backpressure. The existing overflow policy
applies to a queue filled with distinct control messages.

The executable accepts `--measure` to report just the blocked-writer workload on
an earlier implementation. It prints producer enqueue time, delivered line count,
bytes including newlines, and overflow drops. Compare optimized builds on the same
machine with interleaved runs. The timing boundary covers producer enqueue work;
desktop input-to-display latency requires a separate measurement.

## Production assets and overlays

`test:performance` first exercises the real settings store, input bridge and native
simulation process: background settings updates, changed input configuration,
enable commands, native toggles, restart, buffered output after exit and persistence.
A room scenario performs 1,000 join, authenticated ping and leave cycles through
the production manager and a controlled transport boundary. Incoming ping, emote-transfer and ballot rate-limit
buckets must be empty after leaving. The packets use the current signed room protocol.

The command then launches Electron with disposable application data. It uses the
real `lolping://` protocol and loads the built overlay and preload twice. The
scenario checks body-free HEAD probes, GET content, rejected paths, custom-emote
fallback and cache invalidation, wheel release, all sound decodes, bundled animation
decoding and emote removal. Each overlay receives 1,000 pings and 1,000 replacement
toasts. Its pending expiry timers must stay bounded by the 60 visible pings and one
toast, then reach zero. A replacement during the toast's fade keeps its own lifetime.
Timer and decode instrumentation runs through Chromium's debugger before page load;
these diagnostic runs report resource counts, not renderer timing. Audio output is muted.
Physical input hooks and network room connections remain inactive. The parent process
removes temporary data after Electron exits. Any failed check returns a nonzero status.

Pass a packaged ASAR to check the shipped renderer files:

```sh
npm run dist:mac
npm run test:performance -- release/mac-arm64/lolPing.app/Contents/Resources/app.asar
```

On Windows, run `npm run dist`, then
`npm run test:performance -- release/win-unpacked/resources/app.asar`.
On Linux, run `npm run dist:linux`, then
`xvfb-run -a npm run test:performance -- release/linux-unpacked/resources/app.asar`.
CI exercises the three packaged paths and retains their installers as artifacts.

An optional `--measure` after the artifact path skips HEAD and burst-timer checks when
loading an earlier renderer bundle. The protocol comes from the current checkout;
compare protocol revisions from their respective checkouts. Full application
startup, physical input hooks and installer interactions need their own platform
checks.

## Package size

Production bundles use the existing esbuild minifier. Electron retains English
and Chinese resources, matching the application's language choices. The locale
list includes Windows and Linux language tags and macOS `.lproj` names. The DMG uses UDBZ,
a format supported by the pinned electron-builder version. Animation and image
files remain unchanged. The 12 ping sounds use lossless FLAC, preserving their
16-bit PCM and reducing encoded bytes. Audio remains predecoded for immediate
playback; decoded buffer memory and the eight-voice limit remain unchanged.

Compare the current ping audio with original WAV files from a Git revision:

```sh
node tools/performance/audio-assets.mjs <revision-containing-original-WAV-files>
```

The scenario uses Electron's Web Audio decoder at 44.1 kHz and 48 kHz, checking
every channel and sample against the original audio. Six interleaved rounds report
sequential decode times for each format. The comparison needs the baseline Git
objects; normal packaged scenarios always check the current sounds decode.

For size comparisons, build both revisions with the same lockfile, platform and
architecture. Record total JavaScript bytes, ASAR bytes, app regular-file bytes
without following symlinks, and installer bytes separately. Compression changes
installer transfer size; app size determines the installed file footprint.

## Modifier dispatch

`test:helper` also runs `decision-scenario`: all 2,048 combinations of the 11 generic,
left and right modifier keys, non-modifier interference, each key's release and
OS-state resynchronization. The public toggle behavior supplies 28,672 checks.
The implementation reads those 11 relevant states directly, preserving the existing
key-state owner and avoiding a scan of all 256 virtual keys on the input hot path.

`native/hook-helper/build/decision-scenario --measure` reports one million events
each for typing, idle clicks and an active drag. Build the same scenario against
each revision's `decision.cpp` with identical optimized compiler flags, warm both,
and interleave runs. The boundary covers per-event field updates, `Decision::onEvent`
and result consumption. Operating-system hooks, IPC and rendering require
separate measurements.
