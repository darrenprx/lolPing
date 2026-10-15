// X11 platform layer for the hook helper (Linux / UOS).
//
// Windows low-level hooks can swallow events; X11 cannot observe-and-block, so this layer is built
// on grabs instead: a passive grab routes matching input only to us, which IS the swallow. Events a
// gesture should not own go back to the system with XAllowEvents(ReplayPointer/ReplayKeyboard) — a
// genuine re-delivery by the server, not an injection, so there is no echo to filter out.
//
//   - XGrabButton (drag buttons, AnyModifier): every press of those buttons routes through Decision;
//     untriggered clicks are replayed, a gesture press is consumed and the passive grab stays active
//     until release, capturing the drag.
//   - XGrabKey (wheel trigger keys, the toggle chord): consumed or replayed per Decision.
//   - While a gesture is pending or a wheel is open, XGrabKeyboard routes keys through Decision too
//     (Esc cancels, the trigger's key-up ends the gesture); pass-through re-fakes the key.
//   - Injection (plain-click replay) happens after releasing the grabs, so no self-injected event is
//     ever fed back into Decision.
// Project headers first: Xlib.h #defines None, which would break the Btn/Trigger enumerators.
#include "app.h"
#include "commands.h"

#include <X11/Xatom.h>
#include <X11/XKBlib.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XTest.h>
#include <X11/keysym.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <mutex>
#include <optional>
#include <queue>
#include <set>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>
#include <cstdarg>

// Xlib.h pollutes the global namespace with names our enums use; X calls below pass 0 instead.
#undef None

namespace lp {
namespace {

// Windows VK codes the decision layer speaks (see decision.cpp).
constexpr uint32_t kVkLShift = 0xA0, kVkRShift = 0xA1, kVkLCtrl = 0xA2, kVkRCtrl = 0xA3;
constexpr uint32_t kVkLAlt = 0xA4, kVkRAlt = 0xA5, kVkLWin = 0x5B, kVkRWin = 0x5C;

unsigned xMaskOfMods(uint32_t mods) {
  unsigned m = 0;
  if (mods & ModShift) m |= ShiftMask;
  if (mods & ModCtrl) m |= ControlMask;
  if (mods & ModAlt) m |= Mod1Mask;  // Alt is Mod1 on every mainstream layout
  if (mods & ModWin) m |= Mod4Mask;  // Super is Mod4
  return m;
}

std::optional<Btn> btnOf(unsigned button) {
  switch (button) {
    case Button1: return Btn::Left;
    case Button2: return Btn::Middle;
    case Button3: return Btn::Right;
    case 8: return Btn::X1;
    case 9: return Btn::X2;
    default: return std::nullopt;
  }
}

unsigned buttonOf(Btn btn) {
  switch (btn) {
    case Btn::Left: return Button1;
    case Btn::Middle: return Button2;
    case Btn::Right: return Button3;
    case Btn::X1: return 8;
    case Btn::X2: return 9;
    default: return 0;
  }
}

int ignoreErrors(Display*, XErrorEvent*) { return 0; }  // grabs can race; a failed grab must not kill the helper

// Diagnostic log (temporary, for field debugging on UOS). Shared path so the assistant can read it too.
static void hlog(const char* fmt, ...) {
  static FILE* f = nullptr;
  if (!f) f = fopen("/home/suma/lolping_hook_diag.log", "a");
  if (!f) return;
  va_list ap;
  va_start(ap, fmt);
  vfprintf(f, fmt, ap);
  va_end(ap);
  fputc('\n', f);
  fflush(f);
}

uint64_t steadyMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

class XHooks {
 public:
  int run(Output& out);

 private:
  void buildKeymaps();
  uint32_t vkOfKeycode(KeyCode kc) const;
  KeyCode keycodeOfVk(uint32_t vk) const;
  bool isKeyDown(uint32_t vk) const;
  bool clickIsOnFullscreenApp(int x, int y) const;

  void installGrabs();
  void clearGrabs();
  void grabTriggerKey(Trigger t, uint32_t customVk);
  int grabKeyAnyLock(KeyCode kc, unsigned mods);
  void grabButtonAny(unsigned button);

  void syncGrabs();
  Result apply(const Result& r);
  void inject(const std::vector<Inject>& injects);
  void handleKeyEvent(XKeyEvent& ev, bool press);
  void handleButtonEvent(XButtonEvent& ev, bool press);
  void handleMotion(XMotionEvent& ev);
  void handleCommand(const std::string& line);
  void replayKey(XKeyEvent& ev);

  Display* dpy_ = nullptr;
  Window root_ = 0;
  Decision* decision_ = nullptr;
  Output* out_ = nullptr;

  std::map<uint32_t, KeyCode> vkToKc_;
  std::map<KeyCode, uint32_t> kcToVk_;

  std::vector<unsigned> grabbedButtons_;
  std::vector<std::pair<KeyCode, unsigned>> grabbedKeys_;
  bool keyboardGrabbed_ = false;

  std::mutex cmdMu_;
  std::queue<std::string> cmds_;
};

uint32_t vkOfKeysym(KeySym ks) {
  if (ks >= XK_a && ks <= XK_z) return 0x41 + static_cast<uint32_t>(ks - XK_a);
  if (ks >= XK_A && ks <= XK_Z) return 0x41 + static_cast<uint32_t>(ks - XK_A);
  if (ks >= XK_0 && ks <= XK_9) return 0x30 + static_cast<uint32_t>(ks - XK_0);
  if (ks >= XK_F1 && ks <= XK_F24) return 0x70 + static_cast<uint32_t>(ks - XK_F1);
  switch (ks) {
    case XK_space: return 0x20;
    case XK_Escape: return 0x1B;
    case XK_Return:
    case XK_KP_Enter: return 0x0D;
    case XK_Tab: return 0x09;
    case XK_BackSpace: return 0x08;
    case XK_Delete: return 0x2E;
    case XK_Insert: return 0x2D;
    case XK_Home: return 0x24;
    case XK_End: return 0x23;
    case XK_Prior: return 0x21;
    case XK_Next: return 0x22;
    case XK_Left: return 0x25;
    case XK_Up: return 0x26;
    case XK_Right: return 0x27;
    case XK_Down: return 0x28;
    case XK_Shift_L: return kVkLShift;
    case XK_Shift_R: return kVkRShift;
    case XK_Control_L: return kVkLCtrl;
    case XK_Control_R: return kVkRCtrl;
    case XK_Alt_L: return kVkLAlt;
    case XK_Alt_R: return kVkRAlt;
    case XK_Super_L: return kVkLWin;
    case XK_Super_R: return kVkRWin;
    case XK_Caps_Lock: return 0x14;
    case XK_Num_Lock: return 0x90;
    case XK_Print: return 0x2C;
    case XK_Pause: return 0x13;
    case XK_minus: return 0xBD;
    case XK_equal: return 0xBB;
    case XK_bracketleft: return 0xDB;
    case XK_bracketright: return 0xDD;
    case XK_semicolon: return 0xBA;
    case XK_apostrophe: return 0xDE;
    case XK_grave: return 0xC0;
    case XK_backslash: return 0xDC;
    case XK_comma: return 0xBC;
    case XK_period: return 0xBE;
    case XK_slash: return 0xBF;
    default: return 0;
  }
}

void XHooks::buildKeymaps() {
  int minKc = 0, maxKc = 0, per = 0;
  XDisplayKeycodes(dpy_, &minKc, &maxKc);
  KeySym* syms = XGetKeyboardMapping(dpy_, static_cast<KeyCode>(minKc), maxKc - minKc + 1, &per);
  if (!syms) return;
  for (int kc = minKc; kc <= maxKc; ++kc) {
    for (int col = 0; col < per; ++col) {
      const uint32_t vk = vkOfKeysym(syms[(kc - minKc) * per + col]);
      if (vk == 0) continue;
      if (vkToKc_.find(vk) == vkToKc_.end()) {
        vkToKc_[vk] = static_cast<KeyCode>(kc);
        kcToVk_[static_cast<KeyCode>(kc)] = vk;
      }
    }
  }
  XFree(syms);
}

uint32_t XHooks::vkOfKeycode(KeyCode kc) const {
  const auto it = kcToVk_.find(kc);
  return it == kcToVk_.end() ? 0 : it->second;
}

KeyCode XHooks::keycodeOfVk(uint32_t vk) const {
  const auto it = vkToKc_.find(vk);
  return it == vkToKc_.end() ? 0 : it->second;
}

bool XHooks::isKeyDown(uint32_t vk) const {
  char keys[32] = {};
  XQueryKeymap(dpy_, keys);
  const KeyCode kc = keycodeOfVk(vk);
  return kc != 0 && (keys[kc / 8] & (1 << (kc % 8))) != 0;
}

// True when the topmost client window under (x, y) — other than our own overlays and the desktop —
// covers a monitor in the EWMH fullscreen state: a game owns that screen, so clicks belong to it.
bool XHooks::clickIsOnFullscreenApp(int x, int y) const {
  const Atom stacking = XInternAtom(dpy_, "_NET_CLIENT_LIST_STACKING", True);
  const Atom pidAtom = XInternAtom(dpy_, "_NET_WM_PID", True);
  const Atom typeAtom = XInternAtom(dpy_, "_NET_WM_WINDOW_TYPE", True);
  const Atom desktopType = XInternAtom(dpy_, "_NET_WM_WINDOW_TYPE_DESKTOP", True);
  const Atom stateAtom = XInternAtom(dpy_, "_NET_WM_STATE", True);
  const Atom fullscreenState = XInternAtom(dpy_, "_NET_WM_STATE_FULLSCREEN", True);
  if (!stacking || !stateAtom || !fullscreenState) return false;

  Atom actual = 0;
  int format = 0;
  unsigned long n = 0, left = 0;
  unsigned char* data = nullptr;
  if (XGetWindowProperty(dpy_, root_, stacking, 0, 1024, False, XA_WINDOW, &actual, &format, &n, &left, &data) != Success ||
      actual != XA_WINDOW || n == 0) {
    if (data) XFree(data);
    return false;
  }
  const Window* wins = reinterpret_cast<const Window*>(data);
  bool found = false;
  for (unsigned long i = n; i-- > 0 && !found;) {  // stacking order: last is topmost
    const Window w = wins[i];
    // Our own overlay windows sit on top of everything and must not hide the app below them.
    if (pidAtom) {
      Atom a = 0;
      int f = 0;
      unsigned long pn = 0, pl = 0;
      unsigned char* pd = nullptr;
      if (XGetWindowProperty(dpy_, w, pidAtom, 0, 1, False, XA_CARDINAL, &a, &f, &pn, &pl, &pd) == Success && a == XA_CARDINAL &&
          pn == 1 && pd) {
        const unsigned long pid = *reinterpret_cast<const unsigned long*>(pd);
        XFree(pd);
        if (pid == static_cast<unsigned long>(getpid())) continue;
      } else if (pd) {
        XFree(pd);
      }
    }
    Window child = 0;
    int wx = 0, wy = 0;
    if (!XTranslateCoordinates(dpy_, w, root_, 0, 0, &wx, &wy, &child)) continue;
    XWindowAttributes attr{};
    if (!XGetWindowAttributes(dpy_, w, &attr) || attr.map_state != IsViewable) continue;
    if (x < wx || y < wy || x >= wx + attr.width || y >= wy + attr.height) continue;
    if (typeAtom && desktopType) {
      Atom a = 0;
      int f = 0;
      unsigned long tn = 0, tl = 0;
      unsigned char* td = nullptr;
      if (XGetWindowProperty(dpy_, w, typeAtom, 0, 32, False, XA_ATOM, &a, &f, &tn, &tl, &td) == Success && a == XA_ATOM && td) {
        const Atom* types = reinterpret_cast<const Atom*>(td);
        for (unsigned long k = 0; k < tn; ++k) {
          if (types[k] == desktopType) {
            found = false;
            i = 0;  // stop the scan: only the desktop is under the point
            break;
          }
        }
        XFree(td);
        if (i == 0) break;
      }
    }
    Atom a = 0;
    int f = 0;
    unsigned long sn = 0, sl = 0;
    unsigned char* sd = nullptr;
    if (XGetWindowProperty(dpy_, w, stateAtom, 0, 64, False, XA_ATOM, &a, &f, &sn, &sl, &sd) == Success && a == XA_ATOM && sd) {
      const Atom* states = reinterpret_cast<const Atom*>(sd);
      for (unsigned long k = 0; k < sn; ++k) {
        if (states[k] == fullscreenState) found = true;
      }
      XFree(sd);
    }
    break;  // first non-own, non-desktop client under the point decides
  }
  XFree(data);
  return found;
}

// Returns the number of successful grabs (0 means a competing client already owns this chord — a UOS
// global shortcut, e.g. Ctrl+Alt+P for the screen reader — and we cannot preempt it).
int XHooks::grabKeyAnyLock(KeyCode kc, unsigned mods) {
  if (kc == 0) return 0;
  int ok = 0;
  const unsigned locks[] = {0, LockMask, Mod2Mask, LockMask | Mod2Mask};  // with/without Caps Lock and Num Lock
  for (const unsigned lock : locks) {
    // Sync KEYBOARD grab (keyboard_mode=Sync): a captured key is frozen until we call XAllowEvents(ReplayKeyboard),
    // so a non-gesture key passes through to the window under the cursor. (pointer_mode=Async leaves the pointer
    // untouched.) Async would drop the key and XTest needs an extension that may be disabled.
    if (XGrabKey(dpy_, kc, mods | lock, root_, False, GrabModeAsync, GrabModeSync) == GrabSuccess) {
      grabbedKeys_.emplace_back(kc, mods | lock);
      ++ok;
    }
  }
  return ok;
}

void XHooks::grabTriggerKey(Trigger t, uint32_t customVk) {
  std::vector<uint32_t> vks;
  switch (t) {
    case Trigger::Alt: vks = {kVkLAlt, kVkRAlt}; break;
    case Trigger::Ctrl: vks = {kVkLCtrl, kVkRCtrl}; break;
    case Trigger::Shift: vks = {kVkLShift, kVkRShift}; break;
    case Trigger::Win: vks = {kVkLWin, kVkRWin}; break;
    case Trigger::CapsLock: vks = {0x14}; break;
    case Trigger::CustomVk: vks = {customVk}; break;
    default: return;
  }
  for (const uint32_t vk : vks) grabKeyAnyLock(keycodeOfVk(vk), AnyModifier);
}

void XHooks::grabButtonAny(unsigned button) {
  if (button == 0) return;
  // Sync passive grab: a captured pointer event is FROZEN until we call XAllowEvents exactly once.
  //   - ReplayPointer re-injects the frozen event to the window under the cursor (it re-arms the grab
  //     WITHOUT re-freezing this event), so a normal click reaches the app.
  //   - AsyncPointer drops it, used while a gesture owns the pointer.
  // Every captured event (press/release/motion, mapped or unmapped) MUST be allowed once, or the queue
  // freezes and the pointer sticks. This path does NOT rely on the XTest extension.
  XGrabButton(dpy_, button, AnyModifier, root_, False,
              ButtonPressMask | ButtonReleaseMask | ButtonMotionMask, GrabModeSync, GrabModeAsync, 0, 0);
  grabbedButtons_.push_back(button);
}

void XHooks::clearGrabs() {
  for (const unsigned b : grabbedButtons_) XUngrabButton(dpy_, b, AnyModifier, root_);
  for (const auto& [kc, mods] : grabbedKeys_) XUngrabKey(dpy_, kc, mods, root_);
  grabbedButtons_.clear();
  grabbedKeys_.clear();
}

// Passive grabs decide which events reach us at all; Decision then filters per event. Grabbed:
//   - the buttons that can start a gesture (drag buttons),
//   - each wheel's trigger key (a key trigger is consumed while active, replayed when disabled),
//   - the toggle chord's key (Decision matches the full modifier set itself).
void XHooks::installGrabs() {
  clearGrabs();
  const Config& c = decision_->config();
  std::set<unsigned> buttons;
  const auto dragButtonOf = [](Trigger t) -> unsigned {
    if (t == Trigger::Mouse4) return 8u;
    if (t == Trigger::Mouse5) return 9u;
    return Button1;
  };
  if (c.trigger != Trigger::None) buttons.insert(dragButtonOf(c.trigger));
  if (c.emoteTrigger != Trigger::None) buttons.insert(dragButtonOf(c.emoteTrigger));
  for (const unsigned b : buttons) grabButtonAny(b);
  grabTriggerKey(c.trigger, c.triggerVk);
  grabTriggerKey(c.emoteTrigger, c.emoteTriggerVk);
  const int toggleOk = grabKeyAnyLock(keycodeOfVk(c.toggleVk), xMaskOfMods(c.toggleMods));
  if (toggleOk == 0)
    hlog("WARN toggle vk=0x%X grab failed (BadAccess): a UOS global shortcut owns this chord, so the "
         "enable/disable hotkey will NOT fire. Rebind it in Settings (开关快捷键) to a combo UOS does not reserve.",
         (int)c.toggleVk);
  // Also grab the bare modifier keys (Ctrl/Shift/Win) so Decision's mods() — built from keyDown_ — reflects
  // them even though only the trigger and toggle keys are otherwise captured. They are replayed, never
  // swallowed, so the OS still sees every Ctrl/Shift/Win press. Without this, a Ctrl+Shift+P toggle never
  // matched its mods() because Ctrl was never reported as down (Ctrl isn't a grab target on its own).
  const uint32_t modKeys[] = {kVkLShift, kVkRShift, kVkLCtrl, kVkRCtrl, kVkLWin, kVkRWin};
  for (uint32_t vk : modKeys) grabKeyAnyLock(keycodeOfVk(vk), 0);
  XFlush(dpy_);
  hlog("installGrabs: buttons=%zu keys=%zu trigger=%d emote=%d enabled=%d",
       grabbedButtons_.size(), grabbedKeys_.size(),
       (int)c.trigger, (int)c.emoteTrigger, (int)c.enabled);
}

// X11 does NOT use an active keyboard grab. Trigger keys (Alt/Ctrl/Shift/Win) are owned by passive
// XGrabKey and replayed with ReplayKeyboard, which keeps their modifier state correct WITHOUT XTest —
// an active grab would force every pass-through key through XTestFakeKeyEvent, and when that extension
// is disabled (UOS) the trigger-up would be lost and the modifier would stick. Esc-to-cancel still works
// via the trigger key-up (releasing Alt/Ctrl ends the gesture). keyboardGrabbed_ stays false so replayKey
// always takes the XTest-free ReplayKeyboard path.
void XHooks::syncGrabs() {
  keyboardGrabbed_ = false;
}

void XHooks::inject(const std::vector<Inject>& injects) {
  // Replay happens grab-free: releases first, so faked events reach the app instead of ourselves.
  XUngrabPointer(dpy_, CurrentTime);
  XUngrabKeyboard(dpy_, CurrentTime);
  keyboardGrabbed_ = false;
  for (const auto& i : injects) {
    if (i.kind == InjectKind::ButtonDown || i.kind == InjectKind::ButtonUp) {
      const unsigned b = buttonOf(i.btn);
      if (b != 0) XTestFakeButtonEvent(dpy_, b, i.kind == InjectKind::ButtonDown, CurrentTime);
    } else {
      const KeyCode kc = keycodeOfVk(i.vk);
      if (kc != 0) XTestFakeKeyEvent(dpy_, kc, i.kind == InjectKind::KeyDown, CurrentTime);
    }
  }
  XFlush(dpy_);
}

Result XHooks::apply(const Result& r) {
  for (const auto& e : r.emits) out_->emit(e);
  if (!r.injects.empty()) inject(r.injects);
  syncGrabs();
  return r;
}

void XHooks::replayKey(XKeyEvent& ev) {
  // A key event only reaches us through a grab. ReplayKeyboard releases a passive grab (it re-arms
  // for the next press), but it would drop the gesture's active keyboard grab — there, the key is
  // re-faked after a quick ungrab/regrab so pass-through keeps the capture alive.
  if (!keyboardGrabbed_) {
    XAllowEvents(dpy_, ReplayKeyboard, ev.time);
    return;
  }
  XUngrabKeyboard(dpy_, CurrentTime);
  keyboardGrabbed_ = false;
  const KeyCode kc = ev.keycode;
  if (kc != 0) {
    const bool press = ev.type == KeyPress;
    XTestFakeKeyEvent(dpy_, kc, press, CurrentTime);
  }
  XFlush(dpy_);
  keyboardGrabbed_ = XGrabKeyboard(dpy_, root_, False, GrabModeAsync, GrabModeAsync, CurrentTime) == GrabSuccess;
}

void XHooks::handleKeyEvent(XKeyEvent& ev, bool press) {
  const uint32_t vk = vkOfKeycode(ev.keycode);
  if (vk == 0) {
    replayKey(ev);  // a key we don't map is never ours
    return;
  }
  InputEvent e;
  e.kind = press ? EvKind::KeyDown : EvKind::KeyUp;
  e.vk = vk;
  e.timeMs = steadyMs();
  const Result r = decision_->onEvent(e);
  for (const auto& em : r.emits) out_->emit(em);
  if (!r.injects.empty()) inject(r.injects);
  if (vk != 0) hlog("keyevent vk=0x%X %s swallow=%d state=%d", vk, press ? "down" : "up", r.swallow, (int)decision_->state());
  if (r.swallow) {
    // Sync keyboard grab: the frozen event MUST be released exactly once. AsyncKeyboard DROPS it (the
    // window never sees it); ReplayKeyboard would re-deliver it and defeat the swallow. This is the path
    // that makes Ctrl+Shift+P toggle without sticking the P key — and without it a swallowed key would
    // freeze the queue forever.
    XAllowEvents(dpy_, AsyncKeyboard, ev.time);
    syncGrabs();
    return;
  }
  replayKey(ev);
  syncGrabs();
}

void XHooks::handleButtonEvent(XButtonEvent& ev, bool press) {
  const std::optional<Btn> btn = btnOf(ev.button);
  InputEvent e;
  e.x = ev.x_root;
  e.y = ev.y_root;
  e.timeMs = steadyMs();
  if (!btn) {
    // Wheel/extra buttons during a gesture grab are dropped; outside a grab they never arrive. Still MUST
    // be allowed once or the frozen event sticks.
    XAllowEvents(dpy_, AsyncPointer, ev.time);
    return;
  }
  e.kind = press ? EvKind::MouseDown : EvKind::MouseUp;
  e.btn = *btn;
  if (press) decision_->syncKeyStates([this](uint32_t vk) { return isKeyDown(vk); });
  const Result r = decision_->onEvent(e);
  for (const auto& em : r.emits) out_->emit(em);
  if (!r.injects.empty()) inject(r.injects);
  syncGrabs();
  // Frozen event: replay it to the real window (re-arms the grab without re-freezing this event) so a
  // normal click works; drop it (AsyncPointer) while a gesture owns the pointer. This does NOT use XTest.
  if (btn) hlog("%s btn=%d swallow=%d state=%d", press ? "mousedown" : "mouseup", (int)*btn, r.swallow, (int)decision_->state());
  // A swallowed gesture button event is DROPPED, not replayed. The entire gesture (press + drag +
  // release) is owned by us; the window under the cursor never sees those events, so there is no
  // half-click and the button cannot stick. Replaying a swallowed press would also deactivate the
  // passive grab and silently drop the trailing drag motions — that was why repeated Alt+drags failed
  // to open the wheel. Only an un-swallowed (normal) click is replayed so the app receives it. This
  // path does NOT use XTest, so it works even when the XTest extension is disabled (e.g. on UOS).
  XAllowEvents(dpy_, r.swallow ? AsyncPointer : ReplayPointer, ev.time);
}

void XHooks::handleMotion(XMotionEvent& ev) {
  const Decision::State st = decision_->state();
  if (st == Decision::State::Pending || st == Decision::State::Wheel) {
    hlog("motion st=%d x=%d y=%d", (int)st, ev.x_root, ev.y_root);
    InputEvent e;
    e.kind = EvKind::MouseMove;
    e.x = ev.x_root;
    e.y = ev.y_root;
    e.timeMs = steadyMs();
    const Result r = decision_->onEvent(e);
    for (const auto& em : r.emits) out_->emit(em);
    // Gesture owns the pointer: drop motion so the window under the cursor doesn't follow the drag.
    XAllowEvents(dpy_, AsyncPointer, ev.time);
    return;
  }
  // Plain drag (button held, no gesture): forward motion so selection etc. reaches the window. MUST be
  // allowed once or the pointer freezes (mouse stops moving). This does NOT use XTest.
  XAllowEvents(dpy_, ReplayPointer, ev.time);
}

void XHooks::handleCommand(const std::string& line) {
  const Command c = parseCommand(line, decision_->config());
  switch (c.kind) {
    case Command::Kind::Config:
      apply(decision_->setConfig(c.config));
      // X11 (Sync grab) must swallow an unfinished gesture instead of replaying it as a click, or the
      // real button-up replayed to the window sticks the button down. Windows/macOS keep the default.
      decision_->setSwallowUnfinishedClick(true);
      installGrabs();
      break;
    case Command::Kind::SetEnabled:
      apply(decision_->setEnabled(c.flag));
      break;
    case Command::Kind::Suspend:
      apply(decision_->setSuspended(c.flag));
      break;
    case Command::Kind::Shutdown:
      // loop-exit is checked after the command queue drains
      break;
    default:
      out_->error("invalid command: " + line);
      break;
  }
}

int XHooks::run(Output& out) {
  out_ = &out;
  dpy_ = XOpenDisplay(nullptr);
  if (dpy_ == nullptr) {
    const bool wayland = getenv("WAYLAND_DISPLAY") != nullptr || (getenv("XDG_SESSION_TYPE") != nullptr &&
                                                                   strcmp(getenv("XDG_SESSION_TYPE"), "wayland") == 0);
    out.error(wayland ? "wayland" : "noDisplay",
              wayland ? "no X display (Wayland session): run inside XWayland-capable sessions"
                      : "XOpenDisplay failed: DISPLAY is not set");
    return 2;
  }
  XSetErrorHandler(ignoreErrors);
  root_ = DefaultRootWindow(dpy_);
  buildKeymaps();
  XkbSetDetectableAutoRepeat(dpy_, True, nullptr);  // hold-to-repeat floods Decision with synthetic keys otherwise

  Decision decision;
  decision_ = &decision;
  decision.setFullscreenProbe([this](int x, int y) { return clickIsOnFullscreenApp(x, y); });
  decision.setMaskMenuKeys(false);  // X11 has no Start menu / menu bar opened by a lone Alt or Win key-up

  // stdin reader: Electron's pipe; EOF means Electron is gone and the helper must quit.
  std::thread reader([this] {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      const std::lock_guard<std::mutex> lock(cmdMu_);
      cmds_.push(std::move(line));
    }
    const std::lock_guard<std::mutex> lock(cmdMu_);
    cmds_.push("\x1fquit");  // sentinel: stdin closed
  });
  reader.detach();

  out.ready();

  const int xfd = ConnectionNumber(dpy_);
  bool quit = false;
  uint64_t lastTick = steadyMs();
  while (!quit) {
    while (XPending(dpy_) > 0) {
      XEvent ev{};
      XNextEvent(dpy_, &ev);
      switch (ev.type) {
        case KeyPress:
          handleKeyEvent(ev.xkey, true);
          break;
        case KeyRelease:
          handleKeyEvent(ev.xkey, false);
          break;
        case ButtonPress:
          handleButtonEvent(ev.xbutton, true);
          break;
        case ButtonRelease:
          handleButtonEvent(ev.xbutton, false);
          break;
        case MotionNotify:
          while (XCheckTypedWindowEvent(dpy_, root_, MotionNotify, &ev)) {  // collapse motion bursts
          }
          handleMotion(ev.xmotion);
          break;
        default:
          break;  // grab unfocus etc.
      }
    }
    XFlush(dpy_);

    bool stop = false;
    for (;;) {
      std::string line;
      {
        const std::lock_guard<std::mutex> lock(cmdMu_);
        if (cmds_.empty()) break;
        line = std::move(cmds_.front());
        cmds_.pop();
      }
      if (line == "\x1fquit") {
        stop = true;
        break;
      }
      handleCommand(line);
      if (line == "shutdown") stop = true;
    }
    if (stop) break;

    const uint64_t now = steadyMs();
    if (now - lastTick >= 1000) {
      lastTick = now;
      decision.syncKeyStates([this](uint32_t vk) { return isKeyDown(vk); });
      const Result r = decision.tick(now);
      for (const auto& e : r.emits) out_->emit(e);
      syncGrabs();
    }

    fd_set fds;
    FD_ZERO(&fds);
    FD_SET(xfd, &fds);
    timeval tv{1, 0};
    select(xfd + 1, &fds, nullptr, nullptr, &tv);
  }

  clearGrabs();
  if (keyboardGrabbed_) {
    XUngrabKeyboard(dpy_, CurrentTime);
    keyboardGrabbed_ = false;
  }
  XFlush(dpy_);
  XCloseDisplay(dpy_);
  return 0;
}

}  // namespace

int runHooks(Output& out) {
  XHooks hooks;
  return hooks.run(out);
}

}  // namespace lp
