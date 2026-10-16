//! `--simulate` mode — port of native/hook-helper/src/simulate.cpp.
//!
//! Reads simulated input events from stdin (no OS hooks are installed) and runs them
//! through `Decision`, printing the result lines. This is exactly what the existing
//! `tests/helper/protocol.test.ts` integration test drives, so the Rust binary is a
//! drop-in for the C++ helper in that test.

use crate::decision::Decision;
use crate::protocol::{parse_command, report, Command};
use std::io::{BufRead, Write};

pub fn run<R: BufRead, W: Write>(reader: R, writer: &mut W) {
    let mut d = Decision::new();
    let _ = writeln!(writer, "{{\"type\":\"ready\",\"version\":1}}");
    writer.flush().ok();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let cmd = parse_command(line, &d.config());
        match cmd {
            Command::Config(c) => {
                let r = d.set_config(c);
                report(writer, &r, false);
            }
            Command::SetEnabled(b) => {
                let r = d.set_enabled(b);
                report(writer, &r, false);
            }
            Command::Suspend(b) => {
                let r = d.set_suspended(b);
                report(writer, &r, false);
            }
            Command::Shutdown => break,
            Command::SimEvent(e) => {
                let r = d.on_event(&e);
                report(writer, &r, true);
            }
            Command::SimTick(t) => {
                let r = d.tick(t);
                report(writer, &r, true);
            }
            Command::Invalid => {
                // Serialize (not string-interpolate): the raw command contains quotes that must be escaped,
                // matching the C++ helper's jsonEscape (output.cpp).
                let obj = serde_json::json!({ "type": "error", "message": format!("invalid command: {}", line) });
                let _ = writeln!(writer, "{}", obj);
            }
        }
        writer.flush().ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn run_sim(script: &str) -> String {
        let mut out = Vec::new();
        {
            let r = Cursor::new(script.as_bytes().to_vec());
            sim_run_public(r, &mut out);
        }
        String::from_utf8(out).unwrap()
    }

    // Expose a buffered run for tests without touching the public `run` signature.
    fn sim_run_public<R: BufRead, W: Write>(reader: R, writer: &mut W) {
        run(reader, writer);
    }

    #[test]
    fn sim_drag_emits_wheelopen_and_move() {
        let script = "\
{\"type\":\"sim\",\"ev\":\"kdown\",\"vk\":18}\n\
{\"type\":\"sim\",\"ev\":\"mdown\",\"btn\":\"left\",\"x\":100,\"y\":100}\n\
{\"type\":\"sim\",\"ev\":\"move\",\"x\":300,\"y\":300}\n";
        let out = run_sim(script);
        assert!(out.contains("\"type\":\"wheelOpen\""), "got: {}", out);
        assert!(out.contains("\"type\":\"wheelMove\""), "got: {}", out);
        // The sim line records the swallow + inject decision.
        assert!(out.contains("\"type\":\"sim\""), "got: {}", out);
    }

    #[test]
    fn sim_ready_first() {
        let out = run_sim("");
        assert!(out.starts_with("{\"type\":\"ready\",\"version\":1}"), "got: {}", out);
    }
}
