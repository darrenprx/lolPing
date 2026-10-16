//! Windows backend — direct Win32 FFI, a 1:1 port of
//! native/hook-helper/src/{main_win.cpp, hooks_win.cpp}.
//!
//! Low-level mouse + keyboard hooks (WH_MOUSE_LL / WH_KEYBOARD_LL) on a dedicated thread
//! with its own message loop; injects via `SendInput`; self-injected events are marked with
//! `dwExtraInfo = 0x4C50494E` ("LPIN") so the hook ignores them; `GetAsyncKeyState` backs
//! `syncKeyStates`; a 1 s timer drives the watchdog.
//!
//! Why not `rdev` here: the decision core is VK-code centric (custom trigger VK, toggle VK,
//! and the `VK_NONAME` mask key have no rdev `Key` representation). rdev stays the option
//! for a future cross-platform (macOS/Linux) backend behind the same `InputBackend` trait.
//!
//! Build: `cargo build --features hooks`. **Compiled, but needs on-device validation.**

#![allow(non_snake_case)]
#![allow(non_camel_case_types)]

use crate::decision::{Btn, Decision, EvKind, Inject, InjectKind, InputEvent};
use crate::protocol::{format_emit, parse_command, Command};
use std::io::Write;
use std::mem::zeroed;
use std::ptr;

// ---------------------------------------------------------------------------
// Win32 FFI (subset). Types sized for x86_64-pc-windows.
// ---------------------------------------------------------------------------
type HHOOK = *mut core::ffi::c_void;
type HMODULE = *mut core::ffi::c_void;
type HWND = *mut core::ffi::c_void;
type BOOL = i32;
type DWORD = u32;
type UINT = u32;
type WPARAM = usize;
type LPARAM = isize;
type LRESULT = isize;
type UINT_PTR = usize;
type HOOKPROC = extern "system" fn(i32, WPARAM, LPARAM) -> LRESULT;

#[repr(C)]
struct POINT {
    x: i32,
    y: i32,
}
#[repr(C)]
struct MSLLHOOKSTRUCT {
    pt: POINT,
    mouseData: u32,
    flags: u32,
    time: u32,
    dwExtraInfo: usize,
}
#[repr(C)]
struct KBDLLHOOKSTRUCT {
    vkCode: u32,
    scanCode: u32,
    flags: u32,
    time: u32,
    dwExtraInfo: usize,
}
#[repr(C)]
struct MSG {
    hWnd: HWND,
    message: u32,
    wParam: WPARAM,
    lParam: LPARAM,
    time: u32,
    pt: POINT,
    lPrivate: u32,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct MOUSEINPUT {
    dx: i32,
    dy: i32,
    mouseData: u32,
    dwFlags: u32,
    time: u32,
    dwExtraInfo: usize,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct KEYBDINPUT {
    wVk: u16,
    wScan: u16,
    dwFlags: u32,
    time: u32,
    dwExtraInfo: usize,
}
#[repr(C)]
union InputUnion {
    mi: MOUSEINPUT,
    ki: KEYBDINPUT,
}
#[repr(C)]
struct INPUT {
    type_: u32,
    u: InputUnion,
}

extern "system" {
    fn SetWindowsHookExW(
        idHook: i32,
        lpfn: Option<HOOKPROC>,
        hMod: HMODULE,
        dwThreadId: DWORD,
    ) -> HHOOK;
    fn UnhookWindowsHookEx(hhk: HHOOK) -> BOOL;
    fn CallNextHookEx(hhk: HHOOK, nCode: i32, wParam: WPARAM, lParam: LPARAM) -> LRESULT;
    fn GetMessageW(
        lpMsg: *mut MSG,
        hWnd: HWND,
        wMsgFilterMin: UINT,
        wMsgFilterMax: UINT,
    ) -> BOOL;
    fn PeekMessageW(
        lpMsg: *mut MSG,
        hWnd: HWND,
        wMsgFilterMin: UINT,
        wMsgFilterMax: UINT,
        wRemoveMsg: UINT,
    ) -> BOOL;
    fn PostThreadMessageW(idThread: DWORD, Msg: UINT, wParam: WPARAM, lParam: LPARAM) -> BOOL;
    fn PostQuitMessage(nExitCode: i32);
    fn SetTimer(hWnd: HWND, nIDEvent: UINT_PTR, uElapse: UINT, lpTimerFunc: usize) -> UINT_PTR;
    fn KillTimer(hWnd: HWND, uIDEvent: UINT_PTR) -> BOOL;
    fn SendInput(cInputs: UINT, pInputs: *const INPUT, cbSize: i32) -> UINT;
    fn GetAsyncKeyState(vKey: i32) -> i16;
    fn GetTickCount64() -> u64;
    fn GetModuleHandleW(lpModuleName: *const u16) -> HMODULE;
    fn GetCurrentThreadId() -> DWORD;
    fn SetProcessDpiAwarenessContext(value: isize) -> BOOL;
}

// Hooks / messages / flags
const WH_MOUSE_LL: i32 = 14;
const WH_KEYBOARD_LL: i32 = 13;
const HC_ACTION: i32 = 0;
const WM_MOUSEMOVE: UINT = 0x0200;
const WM_LBUTTONDOWN: UINT = 0x0201;
const WM_LBUTTONUP: UINT = 0x0202;
const WM_RBUTTONDOWN: UINT = 0x0204;
const WM_RBUTTONUP: UINT = 0x0205;
const WM_MBUTTONDOWN: UINT = 0x0207;
const WM_MBUTTONUP: UINT = 0x0208;
const WM_XBUTTONDOWN: UINT = 0x020B;
const WM_XBUTTONUP: UINT = 0x020C;
const WM_KEYDOWN: UINT = 0x0100;
const WM_KEYUP: UINT = 0x0101;
const WM_SYSKEYDOWN: UINT = 0x0104;
const WM_SYSKEYUP: UINT = 0x0105;
const LLMHF_INJECTED: u32 = 0x0000_0001;
const LLKHF_INJECTED: u32 = 0x0000_0010;
const XBUTTON1: u32 = 1;
const XBUTTON2: u32 = 2;
const INPUT_MOUSE: u32 = 0;
const INPUT_KEYBOARD: u32 = 1;
const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN: u32 = 0x0020;
const MOUSEEVENTF_MIDDLEUP: u32 = 0x0040;
const MOUSEEVENTF_XDOWN: u32 = 0x0080;
const MOUSEEVENTF_XUP: u32 = 0x0100;
const KEYEVENTF_EXTENDEDKEY: u32 = 0x0001;
const KEYEVENTF_KEYUP: u32 = 0x0002;
const WM_USER: UINT = 0x0400;
const WM_APP: UINT = 0x8000;
const WM_COMMAND_MSG: UINT = WM_APP + 1;
const WM_QUIT: UINT = 0x0012;
const WM_TIMER: UINT = 0x0113;
const PM_NOREMOVE: UINT = 0x0000;

const SELF_MARKER: usize = 0x4C50_494E; // "LPIN"

// The Decision lives on the hook thread for the whole process. Low-level hooks are delivered
// on the thread that installed them, so all Decision access is single-threaded (no data race).
static mut G_DECISION: *mut Decision = ptr::null_mut();

fn is_extended_vk(vk: u32) -> bool {
    matches!(
        vk,
        0xA5 | 0xA3 | 0x5B | 0x5C | 0x2D | 0x2E | 0x24 | 0x23 | 0x21 | 0x22 | 0x25 | 0x26 | 0x27
            | 0x28
    )
}

fn is_key_down(vk: u32) -> bool {
    (unsafe { GetAsyncKeyState(vk as i32) } & 0x8000u16 as i16) != 0
}

unsafe fn send_injects(injects: &[Inject]) {
    if injects.is_empty() {
        return;
    }
    let mut inputs: Vec<INPUT> = Vec::with_capacity(injects.len());
    for i in injects {
        let mut inp: INPUT = zeroed();
        match i.kind {
            InjectKind::ButtonDown | InjectKind::ButtonUp => {
                let down = i.kind == InjectKind::ButtonDown;
                inp.type_ = INPUT_MOUSE;
                inp.u.mi.dwExtraInfo = SELF_MARKER;
                match i.btn {
                    Btn::Left => {
                        inp.u.mi.dwFlags = if down {
                            MOUSEEVENTF_LEFTDOWN
                        } else {
                            MOUSEEVENTF_LEFTUP
                        }
                    }
                    Btn::Right => {
                        inp.u.mi.dwFlags = if down {
                            MOUSEEVENTF_RIGHTDOWN
                        } else {
                            MOUSEEVENTF_RIGHTUP
                        }
                    }
                    Btn::Middle => {
                        inp.u.mi.dwFlags = if down {
                            MOUSEEVENTF_MIDDLEDOWN
                        } else {
                            MOUSEEVENTF_MIDDLEUP
                        }
                    }
                    Btn::X1 => {
                        inp.u.mi.dwFlags = if down {
                            MOUSEEVENTF_XDOWN
                        } else {
                            MOUSEEVENTF_XUP
                        };
                        inp.u.mi.mouseData = XBUTTON1;
                    }
                    Btn::X2 => {
                        inp.u.mi.dwFlags = if down {
                            MOUSEEVENTF_XDOWN
                        } else {
                            MOUSEEVENTF_XUP
                        };
                        inp.u.mi.mouseData = XBUTTON2;
                    }
                    Btn::None => continue,
                }
            }
            InjectKind::KeyDown | InjectKind::KeyUp => {
                inp.type_ = INPUT_KEYBOARD;
                inp.u.ki.wVk = i.vk as u16;
                inp.u.ki.wScan = 0;
                inp.u.ki.dwFlags = (if i.kind == InjectKind::KeyUp {
                    KEYEVENTF_KEYUP
                } else {
                    0
                }) | (if is_extended_vk(i.vk) {
                    KEYEVENTF_EXTENDEDKEY
                } else {
                    0
                });
                inp.u.ki.dwExtraInfo = SELF_MARKER;
            }
        }
        inputs.push(inp);
    }
    SendInput(
        inputs.len() as UINT,
        inputs.as_ptr(),
        std::mem::size_of::<INPUT>() as i32,
    );
}

/// Emit events to stdout, perform injects, return whether to swallow — mirrors hooks_win.cpp::apply.
fn apply_result(r: &crate::decision::DecisionResult) -> bool {
    let stdout = std::io::stdout();
    let mut w = stdout.lock();
    for e in &r.emits {
        let _ = writeln!(w, "{}", format_emit(e));
    }
    drop(w);
    unsafe {
        send_injects(&r.injects);
    }
    r.swallow
}

unsafe fn with_decision<F: FnOnce(&mut Decision) -> bool>(f: F) -> bool {
    if G_DECISION.is_null() {
        return false;
    }
    f(&mut *G_DECISION)
}

extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        if code == HC_ACTION {
            let m = &*(lparam as *const MSLLHOOKSTRUCT);
            let mut e = InputEvent::default();
            e.x = m.pt.x;
            e.y = m.pt.y;
            e.time_ms = GetTickCount64();
            e.self_injected = (m.flags & LLMHF_INJECTED) != 0 && m.dwExtraInfo == SELF_MARKER;
            let known = match wparam as UINT {
                WM_MOUSEMOVE => {
                    e.kind = EvKind::MouseMove;
                    true
                }
                WM_LBUTTONDOWN => {
                    e.kind = EvKind::MouseDown;
                    e.btn = Btn::Left;
                    true
                }
                WM_LBUTTONUP => {
                    e.kind = EvKind::MouseUp;
                    e.btn = Btn::Left;
                    true
                }
                WM_RBUTTONDOWN => {
                    e.kind = EvKind::MouseDown;
                    e.btn = Btn::Right;
                    true
                }
                WM_RBUTTONUP => {
                    e.kind = EvKind::MouseUp;
                    e.btn = Btn::Right;
                    true
                }
                WM_MBUTTONDOWN => {
                    e.kind = EvKind::MouseDown;
                    e.btn = Btn::Middle;
                    true
                }
                WM_MBUTTONUP => {
                    e.kind = EvKind::MouseUp;
                    e.btn = Btn::Middle;
                    true
                }
                WM_XBUTTONDOWN | WM_XBUTTONUP => {
                    e.kind = if wparam as UINT == WM_XBUTTONDOWN {
                        EvKind::MouseDown
                    } else {
                        EvKind::MouseUp
                    };
                    e.btn = if (m.mouseData >> 16) == XBUTTON1 {
                        Btn::X1
                    } else {
                        Btn::X2
                    };
                    true
                }
                _ => false,
            };
            if known {
                let swallowed = with_decision(|d| {
                    if e.kind == EvKind::MouseDown {
                        d.sync_key_states(is_key_down);
                    }
                    let r = d.on_event(&e);
                    apply_result(&r)
                });
                if swallowed {
                    return 1;
                }
            }
        }
        CallNextHookEx(ptr::null_mut(), code, wparam, lparam)
    }
}

extern "system" fn key_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        if code == HC_ACTION {
            let k = &*(lparam as *const KBDLLHOOKSTRUCT);
            let mut e = InputEvent::default();
            let down = wparam as UINT == WM_KEYDOWN || wparam as UINT == WM_SYSKEYDOWN;
            e.kind = if down { EvKind::KeyDown } else { EvKind::KeyUp };
            e.vk = k.vkCode;
            e.time_ms = GetTickCount64();
            e.self_injected = (k.flags & LLKHF_INJECTED) != 0 && k.dwExtraInfo == SELF_MARKER;
            let swallowed = with_decision(|d| {
                let r = d.on_event(&e);
                apply_result(&r)
            });
            if swallowed {
                return 1;
            }
        }
        CallNextHookEx(ptr::null_mut(), code, wparam, lparam)
    }
}

/// Entry point for the Windows hook backend (called from `platform::run_hooks`).
pub fn run_windows() {
    unsafe {
        // Physical-pixel hook coordinates.
        SetProcessDpiAwarenessContext(-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2

        let boxed = Box::new(Decision::new());
        G_DECISION = Box::into_raw(boxed);

        let thread_id = GetCurrentThreadId();

        // Make sure this thread has a message queue before installing hooks.
        let mut msg: MSG = zeroed();
        PeekMessageW(
            &mut msg,
            ptr::null_mut(),
            WM_USER,
            WM_USER,
            PM_NOREMOVE,
        );

        let mouse_hook = SetWindowsHookExW(
            WH_MOUSE_LL,
            Some(mouse_proc),
            GetModuleHandleW(ptr::null()),
            0,
        );
        let key_hook = SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(key_proc),
            GetModuleHandleW(ptr::null()),
            0,
        );
        if mouse_hook.is_null() || key_hook.is_null() {
            let _ = writeln!(
                std::io::stdout().lock(),
                "{{\"type\":\"error\",\"message\":\"SetWindowsHookEx failed\"}}"
            );
            // Restore ownership so the Decision is freed.
            drop(Box::from_raw(G_DECISION));
            G_DECISION = ptr::null_mut();
            return;
        }
        SetTimer(ptr::null_mut(), 0, 1000, 0);

        // Reader thread: forward stdin lines to the hook thread; EOF -> quit.
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lines() {
                match line {
                    Ok(l) => {
                        let b = Box::into_raw(Box::new(l));
                        PostThreadMessageW(thread_id, WM_COMMAND_MSG, 0, b as LPARAM);
                    }
                    Err(_) => break,
                }
            }
            PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
        });

        let _ = writeln!(
            std::io::stdout().lock(),
            "{{\"type\":\"ready\",\"version\":1}}"
        );

        let mut msg: MSG = zeroed();
        while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
            match msg.message {
                WM_TIMER => {
                    with_decision(|d| {
                        d.sync_key_states(is_key_down);
                        let r = d.tick(GetTickCount64());
                        apply_result(&r)
                    });
                }
                WM_COMMAND_MSG => {
                    let mut b = Box::from_raw(msg.lParam as *mut String);
                    let line = std::mem::take(&mut *b);
                    drop(b);
                    if line == "\0" {
                        PostQuitMessage(0);
                        continue;
                    }
                    let line = line.trim_end_matches('\r').to_string();
                    let cont = with_decision(|d| {
                        let cmd = parse_command(&line, &d.config());
                        match cmd {
                            Command::Config(c) => {
                                let r = d.set_config(c);
                                apply_result(&r);
                            }
                            Command::SetEnabled(v) => {
                                let r = d.set_enabled(v);
                                apply_result(&r);
                            }
                            Command::Suspend(v) => {
                                let r = d.set_suspended(v);
                                apply_result(&r);
                            }
                            Command::Shutdown => return false,
                            _ => {
                                let _ = writeln!(
                                    std::io::stdout().lock(),
                                    "{{\"type\":\"error\",\"message\":\"invalid command\"}}"
                                );
                            }
                        }
                        true
                    });
                    if !cont {
                        break;
                    }
                }
                _ => {}
            }
        }

        KillTimer(ptr::null_mut(), 0);
        UnhookWindowsHookEx(mouse_hook);
        UnhookWindowsHookEx(key_hook);
        if !G_DECISION.is_null() {
            drop(Box::from_raw(G_DECISION));
            G_DECISION = ptr::null_mut();
        }
    }
}
