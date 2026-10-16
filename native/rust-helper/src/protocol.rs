//! Protocol contract between Electron (`src/shared/protocol.ts`) and the helper.
//!
//! Mirrors native/hook-helper/src/{commands.cpp, output.cpp}: the helper reads flat
//! JSON commands on stdin and writes flat JSON events on stdout, one object per line.
//! Coordinates are physical pixels (Windows) / Electron DIPs (macOS).

use crate::decision::{Btn, Config, Emit, EmitKind, EvKind, Inject, InjectKind, InputEvent};
use serde_json::Value;

#[derive(Debug)]
pub enum Command {
    Config(Config),
    SetEnabled(bool),
    Suspend(bool),
    Shutdown,
    SimEvent(InputEvent),
    SimTick(u64),
    Invalid,
}

fn get_bool(m: &Value, k: &str, def: bool) -> bool {
    match m.get(k) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "true",
        _ => def,
    }
}

fn get_int(m: &Value, k: &str, def: i64) -> i64 {
    match m.get(k) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(def),
        Some(Value::String(s)) => s.parse::<i64>().unwrap_or(def),
        _ => def,
    }
}

pub fn parse_trigger(s: &str) -> Option<crate::decision::Trigger> {
    use crate::decision::Trigger::*;
    Some(match s {
        "alt" => Alt,
        "ctrl" => Ctrl,
        "shift" => Shift,
        "win" => Win,
        "capslock" => CapsLock,
        "mouse4" => Mouse4,
        "mouse5" => Mouse5,
        "vk" => CustomVk,
        _ => return None,
    })
}

fn parse_btn(s: &str) -> Btn {
    match s {
        "left" => Btn::Left,
        "right" => Btn::Right,
        "middle" => Btn::Middle,
        "x1" => Btn::X1,
        "x2" => Btn::X2,
        _ => Btn::None,
    }
}

/// Port of commands.cpp::parseCommand. Starts a `config` from `current` and only overrides
/// provided fields (the C++ parser reads flat JSON; here we accept typed JSON, a superset).
pub fn parse_command(line: &str, current: &Config) -> Command {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Command::Invalid,
    };
    if v.as_object().is_none() {
        return Command::Invalid;
    }
    let typ = match v.get("type").and_then(|x| x.as_str()) {
        Some(t) => t,
        None => return Command::Invalid,
    };
    match typ {
        "config" => {
            let mut cfg = *current;
            if let Some(Value::String(t)) = v.get("trigger") {
                if let Some(tr) = parse_trigger(t) {
                    cfg.trigger = tr;
                }
            }
            cfg.trigger_vk = get_int(&v, "triggerVk", cfg.trigger_vk as i64) as u32;
            cfg.click_ping = get_bool(&v, "clickPing", cfg.click_ping);
            let d = get_int(&v, "dragThresholdPx", cfg.drag_threshold_px as i64);
            cfg.drag_threshold_px = if d < 1 { 1 } else { d as i32 };
            cfg.toggle_mods = get_int(&v, "toggleMods", cfg.toggle_mods as i64) as u32;
            cfg.toggle_vk = get_int(&v, "toggleVk", cfg.toggle_vk as i64) as u32;
            cfg.enabled = get_bool(&v, "enabled", cfg.enabled);
            Command::Config(cfg)
        }
        "setEnabled" => Command::SetEnabled(get_bool(&v, "enabled", true)),
        "suspend" => Command::Suspend(get_bool(&v, "on", false)),
        "shutdown" => Command::Shutdown,
        "sim" => {
            let ev = match v.get("ev").and_then(|x| x.as_str()) {
                Some(e) => e,
                None => return Command::Invalid,
            };
            if ev == "tick" {
                return Command::SimTick(get_int(&v, "t", 0) as u64);
            }
            let mut e = InputEvent::default();
            e.time_ms = get_int(&v, "t", 0) as u64;
            e.x = get_int(&v, "x", 0) as i32;
            e.y = get_int(&v, "y", 0) as i32;
            e.vk = get_int(&v, "vk", 0) as u32;
            e.btn = match v.get("btn").and_then(|x| x.as_str()) {
                Some(s) => parse_btn(s),
                None => Btn::None,
            };
            e.self_injected = get_bool(&v, "self", false);
            e.kind = match ev {
                "mdown" => EvKind::MouseDown,
                "mup" => EvKind::MouseUp,
                "move" => EvKind::MouseMove,
                "kdown" => EvKind::KeyDown,
                "kup" => EvKind::KeyUp,
                _ => return Command::Invalid,
            };
            Command::SimEvent(e)
        }
        _ => Command::Invalid,
    }
}

fn btn_name(b: Btn) -> &'static str {
    match b {
        Btn::Left => "left",
        Btn::Right => "right",
        Btn::Middle => "middle",
        Btn::X1 => "x1",
        Btn::X2 => "x2",
        _ => "none",
    }
}

fn emit_type(k: EmitKind) -> &'static str {
    match k {
        EmitKind::WheelOpen => "wheelOpen",
        EmitKind::WheelMove => "wheelMove",
        EmitKind::WheelRelease => "wheelRelease",
        EmitKind::Click => "click",
        _ => "",
    }
}

/// Port of output.cpp::formatEmit — byte-compatible with the C++ helper's stdout.
pub fn format_emit(e: &Emit) -> String {
    match e.kind {
        EmitKind::WheelOpen | EmitKind::WheelMove | EmitKind::WheelRelease | EmitKind::Click => {
            format!(
                "{{\"type\":\"{}\",\"x\":{},\"y\":{}}}",
                emit_type(e.kind),
                e.x,
                e.y
            )
        }
        EmitKind::Cancel => "{\"type\":\"cancel\"}".to_string(),
        EmitKind::Toggled => format!("{{\"type\":\"toggled\",\"enabled\":{}}}", e.enabled),
    }
}

/// Port of simulate.cpp::describeInjects + its `sim` line.
pub fn format_sim(swallow: bool, injects: &[Inject]) -> String {
    let mut s = String::new();
    for i in injects {
        if !s.is_empty() {
            s.push(',');
        }
        match i.kind {
            InjectKind::ButtonDown => {
                s.push_str("down:");
                s.push_str(btn_name(i.btn));
            }
            InjectKind::ButtonUp => {
                s.push_str("up:");
                s.push_str(btn_name(i.btn));
            }
            InjectKind::KeyDown => {
                s.push_str("kdown:");
                s.push_str(&i.vk.to_string());
            }
            InjectKind::KeyUp => {
                s.push_str("kup:");
                s.push_str(&i.vk.to_string());
            }
        }
    }
    format!("{{\"type\":\"sim\",\"swallow\":{},\"inject\":\"{}\"}}", swallow, s)
}

/// Serialize a command the way Electron does (protocol.ts::serializeCommand).
#[allow(dead_code)] // provided for symmetry/tests; the helper itself only *reads* commands
pub fn serialize_command(c: &Value) -> String {
    format!("{}\n", serde_json::to_string(c).unwrap_or_default())
}

/// Convenience: run all emits + sim line for one result (used by `sim`).
pub fn report<W: std::io::Write>(w: &mut W, r: &crate::decision::DecisionResult, with_sim_line: bool) {
    for e in &r.emits {
        let _ = writeln!(w, "{}", format_emit(e));
    }
    if with_sim_line {
        let _ = writeln!(w, "{}", format_sim(r.swallow, &r.injects));
    }
}
