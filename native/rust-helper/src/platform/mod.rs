//! OS input layer — the only ported part that needs on-device validation.
//!
//! The C++ helper (native/hook-helper/src/{main_win.cpp, hooks_win.cpp}) installs a
//! low-level mouse + keyboard hook on a dedicated thread, feeds every event to
//! `Decision::on_event`, emits results to stdout, and performs injects via `SendInput`
//! (marking its own events with `dwExtraInfo = 0x4C50494E` so the hook ignores them).
//! On macOS it uses a CGEvent tap and requires Accessibility permission.
//!
//! The portable brain (`decision` + `protocol` + `sim`) is fully ported and unit-tested.
//! This module wires it to the OS. The recommended cross-platform path is `rdev`
//! (`grab` to intercept/swallow, `simulate` to inject) — and because rdev does NOT feed
//! your own simulated events back into the callback, the `self_injected` concept becomes
//! unused (kept only for behavioural parity with the C++ decision tests).
//!
//! Build/run: `cargo run --features hooks`. Validate against the existing TS integration
//! test by pointing `InputBridge` at this binary (see README.md).

// The trait/`run_with` helpers back a future cross-platform (rdev) backend; the Windows path
// is self-contained in `windows.rs`, so these are intentionally unused for now.
#![allow(dead_code)]

#[cfg(windows)]
pub mod windows;

use crate::decision::{Decision, DecisionResult, Inject};
use crate::protocol::{format_emit, parse_command, Command};
use std::io::{BufRead, Write};
use std::sync::mpsc;

/// Performs injects and reports live key state. Implemented per-OS.
pub trait InputBackend {
    fn inject(&self, injects: &[Inject]);
    fn is_key_down(&self, vk: u32) -> bool;
    fn watch_interval_ms(&self) -> u64 {
        1000
    }
}

/// Emit results to stdout and perform injects — mirrors `hooks_win.cpp::apply`.
pub fn apply<B: InputBackend>(backend: &B, r: &DecisionResult) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for e in &r.emits {
        let _ = writeln!(out, "{}", format_emit(e));
    }
    drop(out);
    backend.inject(&r.injects);
}

/// Spawn a thread that forwards stdin lines (commands) plus an EOF sentinel (`\0`).
pub(crate) fn spawn_stdin_reader() -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) => {
                    let _ = tx.send(l);
                }
                Err(_) => break,
            }
        }
        let _ = tx.send("\0".to_string()); // Electron is gone -> shutdown
    });
    rx
}

/// Run the helper against a backend. Shared by every OS implementation.
pub fn run_with<B: InputBackend>(backend: B) {
    use std::time::{Duration, Instant};
    let mut decision = Decision::new();
    let cmd_rx = spawn_stdin_reader();
    let start = Instant::now();

    // 1) Signal readiness (matches output.cpp::ready).
    println!("{{\"type\":\"ready\",\"version\":1}}");

    // 2) OS-specific hook installation calls `on_event` per input and `apply`s the result.
    //    (Implemented in the platform backend; see README for the algorithm + Windows/Mac map.)

    // 3) Loop: drain stdin commands + drive the watchdog tick + sync key states.
    loop {
        while let Ok(line) = cmd_rx.try_recv() {
            if line == "\0" {
                return;
            }
            let cmd = parse_command(&line, &decision.config());
            let r = match cmd {
                Command::Config(c) => decision.set_config(c),
                Command::SetEnabled(b) => decision.set_enabled(b),
                Command::Suspend(b) => decision.set_suspended(b),
                Command::Shutdown => return,
                _ => DecisionResult::default(),
            };
            apply(&backend, &r);
        }
        let now = start.elapsed().as_millis() as u64;
        let r = decision.tick(now);
        apply(&backend, &r);
        decision.sync_key_states(|vk| backend.is_key_down(vk));
        std::thread::sleep(Duration::from_millis(backend.watch_interval_ms()));
    }
}

#[cfg(feature = "hooks")]
pub fn run_hooks() {
    #[cfg(windows)]
    {
        // Windows: direct Win32 FFI (low-level hooks + SendInput), 1:1 with the C++ helper.
        crate::platform::windows::run_windows();
    }
    #[cfg(not(windows))]
    {
        eprintln!(
            "No hook backend for this OS. Implement InputBackend + the hook install (see README), then call run_with."
        );
        std::process::exit(2);
    }
}
