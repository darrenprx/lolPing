# lolPing helper — Rust port

A drop-in, additive reimplementation of `native/hook-helper` in Rust. It lives **beside** the
original C++ helper (which is untouched) so you can compare and switch. The port mirrors the
C++ architecture 1:1 and keeps the exact stdin/stdout JSON-lines contract with Electron, so the
main process (`InputBridge`) needs **no changes**.

## Why Rust for this layer

The helper's hard part is the global input-decision state machine — and it is already written as a
pure, OS-free core (`decision.cpp`). That is the part worth porting: Rust gives memory safety and a
much nicer cross-platform input ecosystem (`rdev`) without changing the behaviour. The OS-specific
hook plumbing is the only piece that still needs per-platform work, and it is isolated behind a
trait.

## Layout (mirrors `native/hook-helper/src`)

| Rust (this crate)        | C++ original                  | Role |
|--------------------------|-------------------------------|------|
| `src/decision.rs`         | `decision.{h,cpp}`            | Pure input-decision state machine (Idle/Pending/Wheel/SwallowUp). **Fully ported + unit-tested.** |
| `src/protocol.rs`         | `commands.cpp` + `output.cpp` | JSON-lines command parser + event formatter. |
| `src/sim.rs`              | `simulate.cpp`                | `--simulate` test mode. |
| `src/platform/mod.rs`     | `main_win.cpp` + `hooks_win.cpp` + `macinput.cpp` | OS hook backend (gated by `hooks` feature). Windows is **implemented** (direct Win32 FFI); macOS/Linux are the remaining adapters. |
| `src/platform/windows.rs` | `hooks_win.cpp` + `main_win.cpp` (`wmain`) | **Implemented**: WH_MOUSE_LL/WH_KEYBOARD_LL + SendInput + GetAsyncKeyState + 1 s watchdog. Compiled, needs on-device validation. |
| `src/main.rs`             | `main_win.cpp` (`wmain`)      | Entry point, `--simulate` dispatch, DPI awareness. |

## Build & test (offline-capable)

```bash
cd native/rust-helper
cargo test                 # exercises the full brain + --simulate on ANY platform, no OS hooks
cargo run -- --simulate    # identical to the C++ helper's test mode; feed sim JSON on stdin
```

`cargo test` runs the decision unit tests (drag opens wheel, click with/without option, trigger
released early, Esc cancel, toggle mid-gesture, watchdog, mask key for Alt/Win, self-injected
ignored) **and** the simulate-mode tests — these prove the port is behaviourally identical to the
original without needing a Windows/macOS dev box.

## Wire it into Electron — DONE

The binary is already wired in (this repo, v0.2.1 checkout):

- **`src/main/paths.ts` → `helperExePath()`** now prefers the Rust binary when present and falls
  back to the C++ helper. `src/main/index.ts` is unchanged (it already calls `helperExePath()`),
  and `InputBridge` needs no change — both helpers speak the same JSON-lines protocol.
  - Packaged: `resources/lolping-helper.exe`.
  - Dev: `native/rust-helper/target/release/` then `.../debug/`.
  - Force the C++ helper with `LOLPING_HELPER=cpp`.
- **`package.json`**: `build:helper:rust` builds it (`cargo build --release --features hooks`),
  `dist` runs it before packaging, and `win.extraResources` ships `lolping-helper.exe`
  (from `native/rust-helper/target/release/lolping-helper.exe`). macOS packaging still ships only
  the C++ helper (no Rust macOS backend yet).

Validate with the app's own harness: `tests/helper/protocol.test.ts` spawns the helper with
`--simulate`; point its `exe` at `native/rust-helper/target/release/lolping-helper.exe` to run the
same assertions against the Rust binary (a good continuous parity check — the port passes them).

## What is done vs. what needs on-device work

- **Done & tested:** the entire decision brain, the protocol parser/formatter, and `--simulate`
  (`cargo test` 11/11; release binary `--simulate` output matches the C++ helper byte-for-byte).
- **Wired in:** `paths.ts` (auto-prefer + fallback) and `package.json` (`build:helper:rust`,
  `dist`, `win.extraResources`).
- **Windows backend — implemented, needs on-device validation:** `src/platform/windows.rs` is a 1:1
  port of `hooks_win.cpp`/`main_win.cpp`: low-level mouse + keyboard hooks on a dedicated thread,
  injects via `SendInput` (self-marked with `dwExtraInfo = 0x4C50494E`), `GetAsyncKeyState` for
  `syncKeyStates`, a 1 s timer for the watchdog, and a stdin reader thread. Compile it with
  `cargo build --features hooks`; then `npm run dev` and drag over an app to confirm the wheel
  and the Alt/Win menu-suppression behave like the C++ build.

- **macOS/Linux — remaining:** implement `InputBackend` + the event-tap/grab loop. `rdev` is the
  recommended cross-platform crate here (`grab` to intercept/swallow, `simulate` to inject). Because
  rdev does **not** feed your own synthesized events back into the callback, the `self_injected`
  concept becomes unused — kept only for parity with the decision tests.

> Why the Windows backend uses raw FFI + `SendInput` rather than `rdev`: the decision core is
> VK-code centric (custom trigger VK, toggle VK, and the `VK_NONAME`/0xFC mask key have no
> `rdev::Key` representation), so a faithful port needs the raw Win32 path. Raw FFI also links
> cleanly on both the MSVC and GNU toolchains without an extra crate.
