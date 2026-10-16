//! Pure input-decision state machine — 1:1 port of native/hook-helper/src/decision.{h,cpp}.
//!
//! No OS calls. This is the testable "brain" of the helper: given a stream of input
//! events it decides what to swallow, what to emit (wheel open/move/release, click,
//! cancel, toggled) and what to inject (replays, mask key). The exact behaviour is
//! pinned by the unit tests at the bottom, which mirror the C++ decision_test suite.

pub type Vk = u32;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Btn {
    #[default]
    None,
    Left,
    Right,
    Middle,
    X1,
    X2,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum EvKind {
    #[default]
    MouseMove,
    MouseDown,
    MouseUp,
    KeyDown,
    KeyUp,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct InputEvent {
    pub kind: EvKind,
    pub btn: Btn,
    pub vk: Vk,
    pub x: i32,
    pub y: i32,
    pub self_injected: bool,
    pub time_ms: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Trigger {
    Alt,
    Ctrl,
    Shift,
    Win,
    CapsLock,
    Mouse4,
    Mouse5,
    CustomVk,
}

pub const MOD_CTRL: u32 = 1;
pub const MOD_ALT: u32 = 2;
pub const MOD_SHIFT: u32 = 4;
pub const MOD_WIN: u32 = 8;

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub trigger: Trigger,
    pub trigger_vk: Vk,
    pub click_ping: bool,
    pub drag_threshold_px: i32,
    pub toggle_mods: u32,
    pub toggle_vk: Vk,
    pub enabled: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            trigger: Trigger::Alt,
            trigger_vk: 0,
            click_ping: false,
            drag_threshold_px: 8,
            toggle_mods: MOD_CTRL | MOD_ALT,
            toggle_vk: 0x50, // 'P'
            enabled: true,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EmitKind {
    WheelOpen,
    WheelMove,
    WheelRelease,
    Click,
    Cancel,
    Toggled,
}

#[derive(Clone, Copy, Debug)]
pub struct Emit {
    pub kind: EmitKind,
    pub x: i32,
    pub y: i32,
    pub enabled: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InjectKind {
    ButtonDown,
    ButtonUp,
    KeyDown,
    KeyUp,
}

#[derive(Clone, Copy, Debug)]
pub struct Inject {
    pub kind: InjectKind,
    pub btn: Btn,
    pub vk: Vk,
}

#[derive(Default, Debug)]
pub struct DecisionResult {
    pub swallow: bool,
    pub emits: Vec<Emit>,
    pub injects: Vec<Inject>,
}

pub const K_MASK_VK: u32 = 0xFC; // VK_NONAME: harmless key that stops Alt/Win menu activation
pub const K_WATCHDOG_MS: u64 = 10_000;

const VK_SHIFT: u32 = 0x10;
const VK_CTRL: u32 = 0x11;
const VK_ALT: u32 = 0x12;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCTRL: u32 = 0xA2;
const VK_RCTRL: u32 = 0xA3;
const VK_LALT: u32 = 0xA4;
const VK_RALT: u32 = 0xA5;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;

fn mod_bit(vk: u32) -> u32 {
    match vk {
        VK_CTRL | VK_LCTRL | VK_RCTRL => MOD_CTRL,
        VK_ALT | VK_LALT | VK_RALT => MOD_ALT,
        VK_SHIFT | VK_LSHIFT | VK_RSHIFT => MOD_SHIFT,
        VK_LWIN | VK_RWIN => MOD_WIN,
        _ => 0,
    }
}

fn point(kind: EmitKind, x: i32, y: i32) -> Emit {
    Emit { kind, x, y, enabled: false }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Idle,
    Pending,
    Wheel,
    SwallowUp,
}

pub struct Decision {
    cfg: Config,
    enabled: bool,
    suspended: bool,
    state: State,
    key_down: [bool; 256],
    swallow_key_ups: std::collections::HashSet<Vk>,
    swallow_right_up: bool,
    need_mask: bool,
    mask_menu_keys: bool,
    drag_btn: Btn,
    px: i32,
    py: i32,
    last_mouse_ms: u64,
}

impl Default for Decision {
    fn default() -> Self {
        Self::new()
    }
}

impl Decision {
    pub fn new() -> Self {
        Self {
            cfg: Config::default(),
            enabled: true, // matches C++ `enabled_ = true`
            suspended: false,
            state: State::Idle,
            key_down: [false; 256],
            swallow_key_ups: std::collections::HashSet::new(),
            swallow_right_up: false,
            need_mask: false,
            mask_menu_keys: true,
            drag_btn: Btn::None,
            px: 0,
            py: 0,
            last_mouse_ms: 0,
        }
    }

    #[allow(dead_code)] // used by the macOS backend (setMaskMenuKeys(false)); Windows keeps masks on
    pub fn set_mask_menu_keys(&mut self, on: bool) {
        self.mask_menu_keys = on;
    }

    pub fn state(&self) -> State {
        self.state
    }
    pub fn enabled(&self) -> bool {
        self.enabled
    }
    pub fn config(&self) -> Config {
        self.cfg
    }
    pub fn is_active(&self) -> bool {
        self.enabled && !self.suspended
    }

    fn mods(&self) -> u32 {
        let mut m = 0u32;
        for vk in 0..256u32 {
            if self.key_down[vk as usize] {
                m |= mod_bit(vk);
            }
        }
        m
    }

    fn trigger_held(&self) -> bool {
        match self.cfg.trigger {
            Trigger::Alt => (self.mods() & MOD_ALT) != 0,
            Trigger::Ctrl => (self.mods() & MOD_CTRL) != 0,
            Trigger::Shift => (self.mods() & MOD_SHIFT) != 0,
            Trigger::Win => (self.mods() & MOD_WIN) != 0,
            Trigger::CapsLock | Trigger::CustomVk => self.key_down[(self.key_trigger_vk() & 0xFF) as usize],
            _ => false,
        }
    }

    fn is_trigger_vk(&self, vk: u32) -> bool {
        match self.cfg.trigger {
            Trigger::Alt => mod_bit(vk) == MOD_ALT,
            Trigger::Ctrl => mod_bit(vk) == MOD_CTRL,
            Trigger::Shift => mod_bit(vk) == MOD_SHIFT,
            Trigger::Win => mod_bit(vk) == MOD_WIN,
            Trigger::CapsLock | Trigger::CustomVk => vk == self.key_trigger_vk(),
            _ => false,
        }
    }

    fn key_trigger_vk(&self) -> u32 {
        match self.cfg.trigger {
            Trigger::CapsLock => 0x14,
            _ => self.cfg.trigger_vk,
        }
    }

    #[allow(dead_code)]
    fn is_mouse_trigger(&self) -> bool {
        matches!(self.cfg.trigger, Trigger::Mouse4 | Trigger::Mouse5)
    }

    fn drag_button(&self) -> Btn {
        match self.cfg.trigger {
            Trigger::Mouse4 => Btn::X1,
            Trigger::Mouse5 => Btn::X2,
            _ => Btn::Left,
        }
    }

    fn mark_swallow(&mut self) {
        if self.mask_menu_keys && (self.mods() & (MOD_ALT | MOD_WIN)) != 0 {
            self.need_mask = true;
        }
    }

    fn cancel_gesture(&mut self, r: &mut DecisionResult) {
        if matches!(self.state, State::Pending | State::Wheel) {
            r.emits.push(Emit { kind: EmitKind::Cancel, x: 0, y: 0, enabled: false });
            self.state = State::SwallowUp;
        }
    }

    pub fn set_config(&mut self, c: Config) -> DecisionResult {
        let mut r = DecisionResult::default();
        self.cancel_gesture(&mut r);
        self.cfg = c;
        self.enabled = c.enabled;
        r
    }

    pub fn set_enabled(&mut self, on: bool) -> DecisionResult {
        let mut r = DecisionResult::default();
        if !on {
            self.cancel_gesture(&mut r);
        }
        self.enabled = on;
        r
    }

    pub fn set_suspended(&mut self, on: bool) -> DecisionResult {
        let mut r = DecisionResult::default();
        if on {
            self.cancel_gesture(&mut r);
        }
        self.suspended = on;
        r
    }

    pub fn tick(&mut self, now_ms: u64) -> DecisionResult {
        let mut r = DecisionResult::default();
        let busy = matches!(self.state, State::Pending | State::Wheel);
        if busy && now_ms > self.last_mouse_ms && now_ms - self.last_mouse_ms > K_WATCHDOG_MS {
            r.emits.push(Emit { kind: EmitKind::Cancel, x: 0, y: 0, enabled: false });
            self.state = State::SwallowUp;
        }
        r
    }

    pub fn sync_key_states<F: Fn(u32) -> bool>(&mut self, is_down: F) {
        for vk in 0..256u32 {
            // A key whose down we swallowed never reached the OS, so the OS reports it up: keep those.
            if self.key_down[vk as usize]
                && !self.swallow_key_ups.contains(&vk)
                && !is_down(vk)
            {
                self.key_down[vk as usize] = false;
            }
        }
    }

    pub fn on_event(&mut self, e: &InputEvent) -> DecisionResult {
        let mut r = DecisionResult::default();
        if e.self_injected {
            return r;
        }
        match e.kind {
            EvKind::KeyDown => self.on_key_down(e, &mut r),
            EvKind::KeyUp => self.on_key_up(e, &mut r),
            EvKind::MouseDown => {
                self.last_mouse_ms = e.time_ms;
                self.on_mouse_down(e, &mut r);
            }
            EvKind::MouseUp => {
                self.last_mouse_ms = e.time_ms;
                self.on_mouse_up(e, &mut r);
            }
            EvKind::MouseMove => {
                self.last_mouse_ms = e.time_ms;
                self.on_mouse_move(e, &mut r);
            }
        }
        r
    }

    fn on_key_down(&mut self, e: &InputEvent, r: &mut DecisionResult) {
        let vk = e.vk & 0xFF;
        let repeat = self.key_down[vk as usize];
        self.key_down[vk as usize] = true;

        if !self.suspended && vk == self.cfg.toggle_vk && self.mods() == self.cfg.toggle_mods {
            r.swallow = true;
            self.swallow_key_ups.insert(vk);
            self.mark_swallow();
            if !repeat {
                if self.enabled {
                    self.cancel_gesture(r);
                }
                self.enabled = !self.enabled;
                r.emits.push(Emit { kind: EmitKind::Toggled, x: 0, y: 0, enabled: self.enabled });
            }
            return;
        }
        if self.is_active() {
            if vk == 0x1B && matches!(self.state, State::Pending | State::Wheel) {
                r.swallow = true;
                self.swallow_key_ups.insert(vk);
                self.mark_swallow();
                self.cancel_gesture(r);
                return;
            }
            if (self.cfg.trigger == Trigger::CapsLock || self.cfg.trigger == Trigger::CustomVk)
                && vk == self.key_trigger_vk()
            {
                r.swallow = true;
                self.swallow_key_ups.insert(vk);
                return;
            }
        }
        // This down passes through, so any pending up-swallow for the key is stale (its up was lost).
        self.swallow_key_ups.remove(&vk);
    }

    fn on_key_up(&mut self, e: &InputEvent, r: &mut DecisionResult) {
        let vk = e.vk & 0xFF;
        let held_before = self.trigger_held();
        self.key_down[vk as usize] = false;
        let trigger_released = held_before && !self.trigger_held() && self.is_trigger_vk(vk);

        if self.swallow_key_ups.remove(&vk) {
            r.swallow = true;
        }
        if self.need_mask && (mod_bit(vk) == MOD_ALT || mod_bit(vk) == MOD_WIN) {
            self.need_mask = false;
            r.swallow = true;
            r.injects.push(Inject { kind: InjectKind::KeyDown, btn: Btn::None, vk: K_MASK_VK });
            r.injects.push(Inject { kind: InjectKind::KeyUp, btn: Btn::None, vk: K_MASK_VK });
            r.injects.push(Inject { kind: InjectKind::KeyUp, btn: Btn::None, vk });
        }
        if !trigger_released {
            return;
        }
        match self.state {
            State::Pending => {
                if self.cfg.click_ping {
                    r.emits.push(point(EmitKind::Click, self.px, self.py));
                    self.state = State::SwallowUp;
                } else {
                    r.injects.push(Inject { kind: InjectKind::ButtonDown, btn: self.drag_btn, vk: 0 });
                    self.state = State::Idle;
                }
            }
            State::Wheel => {
                r.emits.push(Emit { kind: EmitKind::Cancel, x: 0, y: 0, enabled: false });
                self.state = State::SwallowUp;
            }
            _ => {}
        }
    }

    fn on_mouse_down(&mut self, e: &InputEvent, r: &mut DecisionResult) {
        // The matching up was lost (a previous right-up never arrived, secure desktop, Win+L, UAC).
        if self.state == State::SwallowUp && e.btn == self.drag_btn {
            self.state = State::Idle;
        }
        if e.btn == Btn::Right {
            self.swallow_right_up = false;
        }
        if !self.is_active() {
            return;
        }
        if matches!(self.state, State::Pending | State::Wheel) && e.btn == Btn::Right {
            r.swallow = true;
            self.swallow_right_up = true;
            self.mark_swallow();
            self.cancel_gesture(r);
            return;
        }
        if self.state == State::Idle
            && e.btn == self.drag_button()
            && (self.is_mouse_trigger() || self.trigger_held())
        {
            r.swallow = true;
            self.mark_swallow();
            self.state = State::Pending;
            self.drag_btn = e.btn;
            self.px = e.x;
            self.py = e.y;
        }
    }

    fn on_mouse_up(&mut self, e: &InputEvent, r: &mut DecisionResult) {
        if e.btn == Btn::Right && self.swallow_right_up {
            self.swallow_right_up = false;
            r.swallow = true;
            return;
        }
        if self.state == State::Idle || e.btn != self.drag_btn {
            return;
        }
        r.swallow = true;
        match self.state {
            State::Pending => {
                if self.cfg.click_ping {
                    r.emits.push(point(EmitKind::Click, self.px, self.py));
                } else {
                    r.injects.push(Inject { kind: InjectKind::ButtonDown, btn: self.drag_btn, vk: 0 });
                    r.injects.push(Inject { kind: InjectKind::ButtonUp, btn: self.drag_btn, vk: 0 });
                }
            }
            State::Wheel => {
                r.emits.push(point(EmitKind::WheelRelease, e.x, e.y));
            }
            _ => {}
        }
        self.state = State::Idle;
    }

    fn on_mouse_move(&mut self, e: &InputEvent, r: &mut DecisionResult) {
        if self.state == State::Pending {
            let dx = (e.x - self.px) as f64;
            let dy = (e.y - self.py) as f64;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist > self.cfg.drag_threshold_px as f64 {
                self.state = State::Wheel;
                r.emits.push(point(EmitKind::WheelOpen, self.px, self.py));
                r.emits.push(point(EmitKind::WheelMove, e.x, e.y));
            }
        } else if self.state == State::Wheel {
            r.emits.push(point(EmitKind::WheelMove, e.x, e.y));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: EvKind, btn: Btn, vk: u32, x: i32, y: i32, t: u64) -> InputEvent {
        InputEvent { kind, btn, vk, x, y, self_injected: false, time_ms: t }
    }
    fn kd(vk: u32) -> InputEvent { ev(EvKind::KeyDown, Btn::None, vk, 0, 0, 0) }
    fn ku(vk: u32) -> InputEvent { ev(EvKind::KeyUp, Btn::None, vk, 0, 0, 0) }
    fn md(btn: Btn, x: i32, y: i32) -> InputEvent { ev(EvKind::MouseDown, btn, 0, x, y, 1000) }
    fn mu(btn: Btn, x: i32, y: i32) -> InputEvent { ev(EvKind::MouseUp, btn, 0, x, y, 1000) }
    fn mm(x: i32, y: i32) -> InputEvent { ev(EvKind::MouseMove, Btn::None, 0, x, y, 1000) }

    fn has_kind(r: &DecisionResult, k: EmitKind) -> bool {
        r.emits.iter().any(|e| e.kind == k)
    }

    #[test]
    fn drag_opens_wheel() {
        let mut d = Decision::new();
        d.on_event(&kd(0x12)); // Alt down
        d.on_event(&md(Btn::Left, 100, 100)); // start
        let r = d.on_event(&mm(250, 250)); // move > threshold
        assert!(has_kind(&r, EmitKind::WheelOpen));
        assert!(has_kind(&r, EmitKind::WheelMove));
        assert_eq!(d.state(), State::Wheel);
        let r = d.on_event(&mu(Btn::Left, 250, 250));
        assert!(has_kind(&r, EmitKind::WheelRelease));
        assert_eq!(d.state(), State::Idle);
    }

    #[test]
    fn click_without_option_replays() {
        let mut d = Decision::new();
        d.on_event(&kd(0x12));
        d.on_event(&md(Btn::Left, 100, 100));
        d.on_event(&mm(103, 100)); // < threshold
        assert_eq!(d.state(), State::Pending);
        let r = d.on_event(&mu(Btn::Left, 103, 100));
        assert!(r.emits.is_empty());
        assert!(r.injects.iter().any(|i| i.kind == InjectKind::ButtonDown && i.btn == Btn::Left));
        assert!(r.injects.iter().any(|i| i.kind == InjectKind::ButtonUp && i.btn == Btn::Left));
        assert_eq!(d.state(), State::Idle);
    }

    #[test]
    fn click_with_option_pings() {
        let mut cfg = Config::default();
        cfg.click_ping = true;
        let mut d = Decision::new();
        d.set_config(cfg);
        d.on_event(&kd(0x12));
        d.on_event(&md(Btn::Left, 100, 100));
        d.on_event(&mm(103, 100));
        let r = d.on_event(&mu(Btn::Left, 103, 100));
        assert!(has_kind(&r, EmitKind::Click));
        assert!(r.swallow); // the button-up is swallowed, down+up both accounted for
        assert_eq!(d.state(), State::Idle); // matches C++ onMouseUp (clickPing on -> Idle)
    }

    #[test]
    fn trigger_released_early_replays() {
        let mut d = Decision::new();
        d.on_event(&kd(0x12));
        d.on_event(&md(Btn::Left, 100, 100)); // Pending
        let r = d.on_event(&ku(0x12)); // Alt up -> replay press
        assert!(r.injects.iter().any(|i| i.kind == InjectKind::ButtonDown && i.btn == Btn::Left));
        assert_eq!(d.state(), State::Idle);
    }

    #[test]
    fn esc_cancels_wheel() {
        let mut d = Decision::new();
        d.on_event(&kd(0x12));
        d.on_event(&md(Btn::Left, 100, 100));
        d.on_event(&mm(300, 300)); // Wheel
        let r = d.on_event(&kd(0x1B)); // Esc
        assert!(r.swallow);
        assert!(has_kind(&r, EmitKind::Cancel));
        assert_eq!(d.state(), State::SwallowUp);
    }

    #[test]
    fn toggle_mid_gesture() {
        let mut d = Decision::new();
        d.on_event(&kd(0x12)); // Alt
        d.on_event(&kd(0x11)); // Ctrl -> mods == 3 == toggleMods
        let r = d.on_event(&kd(0x50)); // P
        assert!(has_kind(&r, EmitKind::Toggled));
        let toggled = r.emits.iter().find(|e| e.kind == EmitKind::Toggled).unwrap();
        assert!(!toggled.enabled);
        assert!(!d.enabled());
    }

    #[test]
    fn watchdog_cancels() {
        let mut d = Decision::new();
        d.on_event(&kd(0x12));
        d.on_event(&md(Btn::Left, 100, 100)); // Pending @ t=1000
        let r = d.tick(1000 + K_WATCHDOG_MS + 1);
        assert!(has_kind(&r, EmitKind::Cancel));
        assert_eq!(d.state(), State::SwallowUp);
    }

    #[test]
    fn mask_key_emitted_for_alt_up() {
        let mut d = Decision::new();
        d.on_event(&kd(0x12)); // Alt
        d.on_event(&md(Btn::Left, 100, 100)); // Pending -> mark_swallow sets need_mask
        d.on_event(&mm(300, 300)); // Wheel
        let r = d.on_event(&ku(0x12)); // Alt up -> mask injected
        assert!(r.swallow);
        assert!(r.injects.iter().any(|i| i.kind == InjectKind::KeyDown && i.vk == K_MASK_VK));
        assert!(r.injects.iter().any(|i| i.kind == InjectKind::KeyUp && i.vk == K_MASK_VK));
        assert!(r.injects.iter().any(|i| i.kind == InjectKind::KeyUp && i.vk == 0x12));
    }

    #[test]
    fn self_injected_is_ignored() {
        let mut d = Decision::new();
        let mut e = kd(0x12);
        e.self_injected = true;
        let r = d.on_event(&e);
        assert!(!r.swallow);
        assert!(r.emits.is_empty());
        assert!(r.injects.is_empty());
    }
}
