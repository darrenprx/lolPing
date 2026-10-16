//! lolPing native input helper — Rust port of native/hook-helper.
//!
//! Architecture mirrors the C++ original 1:1:
//!   - `decision` : pure input-decision state machine (the testable brain)
//!   - `protocol` : JSON-lines contract with Electron (src/shared/protocol.ts), serde mirror
//!   - `sim`      : `--simulate` mode (no OS hooks; used by the TS integration test)
//!   - `platform` : OS hook backend (feature `hooks`); stubbed otherwise
//!
//! The Electron side (InputBridge) spawns this binary, writes commands to stdin and reads
//! events from stdout — identical to the C++ helper, so no Electron change is required.

mod decision;
mod protocol;
mod sim;

#[cfg(feature = "hooks")]
mod platform;

fn main() {
    let simulate = std::env::args().nth(1).as_deref() == Some("--simulate");
    if simulate {
        let stdin = std::io::stdin();
        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        sim::run(stdin.lock(), &mut out);
    } else {
        #[cfg(feature = "hooks")]
        {
            platform::run_hooks();
        }
        #[cfg(not(feature = "hooks"))]
        {
            eprintln!(
                "hooks mode requires the `hooks` feature:\n  cargo run --features hooks\n\
                 (or build the default target, which ships the tested brain + --simulate only)"
            );
            std::process::exit(2);
        }
    }
}
